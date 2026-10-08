// Mac approval for connector `act` tools (issue 1712, PR 5). The native
// runtime emits `desktop_tool_approval_request` when an agent wants to act
// through a connector, waits for `desktop_tool_approval_respond`, and treats
// no answer within five minutes as "Not now".

export const TOOL_APPROVAL_REQUEST_EVENT = 'desktop_tool_approval_request';
export const TOOL_APPROVAL_RESOLVED_EVENT = 'desktop_tool_approval_resolved';
export const TOOL_APPROVAL_RESPOND_COMMAND = 'desktop_tool_approval_respond';

export type ToolApprovalPrompt = {
  requestId: string;
  tool: string;
  summary: string;
  connector: string;
  args: unknown;
};

const connectorLabels: Record<string, string> = {
  gmail: 'Gmail',
  calendar: 'Google Calendar',
  google_calendar: 'Google Calendar',
  github: 'GitHub',
  slack: 'Slack',
};

export function connectorLabel(connector: string) {
  const known = connectorLabels[connector.trim().toLowerCase()];
  if (known) return known;
  const words = connector.trim().split(/[_\s]+/).filter(Boolean);
  return words.length ? words.map((word) => word[0].toUpperCase() + word.slice(1)).join(' ') : 'a connected service';
}

/** "Send an email." becomes "send an email". */
function actionPhrase(summary: string, tool: string) {
  const trimmed = summary.trim().replace(/[.\s]+$/, '');
  if (!trimmed) return `use ${tool}`;
  return trimmed[0].toLowerCase() + trimmed.slice(1);
}

export function toolApprovalHeadline(prompt: Pick<ToolApprovalPrompt, 'summary' | 'tool' | 'connector'>) {
  return `Your agent wants to ${actionPhrase(prompt.summary, prompt.tool)} in ${connectorLabel(prompt.connector)}.`;
}

/** A compact, single-line view of the call's arguments, or null when empty. */
export function toolApprovalDetails(args: unknown, maxLength = 160) {
  if (args === null || args === undefined) return null;
  if (typeof args === 'object' && Object.keys(args).length === 0) return null;
  let text: string;
  try {
    text = JSON.stringify(args);
  } catch {
    return null;
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

export function parseToolApprovalPrompt(payload: unknown): ToolApprovalPrompt | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const requestId = text(record.requestId);
  const tool = text(record.tool);
  if (!requestId || !tool) return null;
  return { requestId, tool, summary: text(record.summary), connector: text(record.connector), args: record.args ?? null };
}

/** Pending prompts after a request or resolved event. */
export function applyToolApprovalEvent(
  prompts: readonly ToolApprovalPrompt[],
  event: { kind: 'request'; prompt: ToolApprovalPrompt } | { kind: 'resolved'; requestId: string },
): ToolApprovalPrompt[] {
  if (event.kind === 'resolved') return prompts.filter((prompt) => prompt.requestId !== event.requestId);
  if (prompts.some((prompt) => prompt.requestId === event.prompt.requestId)) return [...prompts];
  return [...prompts, event.prompt];
}
