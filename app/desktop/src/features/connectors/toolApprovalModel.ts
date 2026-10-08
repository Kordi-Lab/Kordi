// Mac approval for connector `act` tools (issue 1712, PR 5). The native
// runtime emits `desktop_tool_approval_request` when an agent wants to act
// through a connector, waits for `desktop_tool_approval_respond`, and treats
// no answer within five minutes as "Not now". Open prompts stay in the native
// runtime; `desktop_tool_approval_pending` returns them to a webview that
// mounts or regains focus later.

export const TOOL_APPROVAL_REQUEST_EVENT = 'desktop_tool_approval_request';
export const TOOL_APPROVAL_RESOLVED_EVENT = 'desktop_tool_approval_resolved';
export const TOOL_APPROVAL_RESPOND_COMMAND = 'desktop_tool_approval_respond';
export const TOOL_APPROVAL_PENDING_COMMAND = 'desktop_tool_approval_pending';

export type ToolApprovalPrompt = {
  requestId: string;
  tool: string;
  summary: string;
  connector: string;
  args: unknown;
  /** True when the native runtime shortened long text to fit the card. */
  argsTruncated: boolean;
  sessionId: string;
  conversationTitle: string | null;
  agentName: string | null;
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

export function toolApprovalHeadline(prompt: Pick<ToolApprovalPrompt, 'summary' | 'tool' | 'connector'> & { agentName?: string | null }) {
  const agent = prompt.agentName?.trim() || 'Your agent';
  return `${agent} wants to ${actionPhrase(prompt.summary, prompt.tool)} in ${connectorLabel(prompt.connector)}.`;
}

/** Which conversation is asking. */
export function toolApprovalSource(prompt: Pick<ToolApprovalPrompt, 'conversationTitle' | 'sessionId'>) {
  const title = prompt.conversationTitle?.trim();
  if (title) return `From “${title}”`;
  return prompt.sessionId ? `From conversation ${prompt.sessionId}` : 'From a conversation';
}

export type ToolApprovalField = { label: string; value: string };
export type ToolApprovalBlock = { label: string; text: string };
export type ToolApprovalView = {
  fields: ToolApprovalField[];
  /** Long text, shown whole in a scrollable block. */
  blocks: ToolApprovalBlock[];
  truncated: boolean;
};

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string' || typeof item === 'number')) {
    return value.join(', ');
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return '(this value cannot be shown)';
  }
}

type FieldSpec = { key: string; label: string; always?: boolean; empty?: string };
type ToolSpec = { fields: FieldSpec[]; blocks: FieldSpec[]; combine?: (args: Record<string, unknown>) => ToolApprovalField[] };

const calendarWhen = (args: Record<string, unknown>): ToolApprovalField[] => {
  const start = displayValue(args.start);
  const end = displayValue(args.end);
  const zone = displayValue(args.timeZone);
  if (!start && !end) return [];
  const range = [start, end].filter(Boolean).join(' – ');
  return [{ label: 'Time', value: zone ? `${range} (${zone})` : range }];
};

const toolSpecs: Record<string, ToolSpec> = {
  gmail_send: {
    fields: [
      { key: 'to', label: 'To', always: true, empty: 'No recipients' },
      { key: 'cc', label: 'Cc' },
      { key: 'bcc', label: 'Bcc' },
      { key: 'subject', label: 'Subject', always: true, empty: '(no subject)' },
    ],
    blocks: [{ key: 'body', label: 'Message' }],
  },
  calendar_create_event: {
    fields: [
      { key: 'summary', label: 'Title', always: true, empty: '(no title)' },
      { key: 'attendees', label: 'Attendees', always: true, empty: 'No attendees' },
      { key: 'location', label: 'Location' },
      { key: 'calendarId', label: 'Calendar' },
    ],
    blocks: [{ key: 'description', label: 'Description' }],
    combine: calendarWhen,
  },
  calendar_respond: {
    fields: [
      { key: 'summary', label: 'Title' },
      { key: 'attendees', label: 'Attendees' },
      { key: 'response', label: 'Response', always: true },
      { key: 'eventId', label: 'Event', always: true },
      { key: 'calendarId', label: 'Calendar' },
    ],
    blocks: [],
    combine: calendarWhen,
  },
  slack_post: {
    fields: [
      { key: 'channel', label: 'Channel', always: true },
      { key: 'threadTs', label: 'Thread' },
    ],
    blocks: [{ key: 'text', label: 'Message' }],
  },
  github_comment: {
    fields: [{ key: 'number', label: 'Number', always: true }],
    blocks: [{ key: 'body', label: 'Comment' }],
    combine: (args) => [{ label: 'Repository', value: [displayValue(args.owner), displayValue(args.repo)].filter(Boolean).join('/') || '(none)' }],
  },
};

const combinedKeys: Record<string, string[]> = {
  calendar_create_event: ['start', 'end', 'timeZone'],
  calendar_respond: ['start', 'end', 'timeZone'],
  github_comment: ['owner', 'repo'],
};

/**
 * Everything the card shows for a call. Known tools get labeled fields and a
 * scrollable block for long text; every other argument, and every argument
 * of an unknown tool, is listed whole under "Other details". Nothing the call
 * carries is left out.
 */
export function toolApprovalView(prompt: Pick<ToolApprovalPrompt, 'tool' | 'args' | 'argsTruncated'>): ToolApprovalView {
  const view: ToolApprovalView = { fields: [], blocks: [], truncated: prompt.argsTruncated };
  const args = prompt.args;
  if (args === null || args === undefined) return view;
  if (typeof args !== 'object' || Array.isArray(args)) {
    const text = displayValue(args);
    if (text) view.blocks.push({ label: 'Request', text });
    return view;
  }
  const record = args as Record<string, unknown>;
  const spec = toolSpecs[prompt.tool];
  const used = new Set<string>(combinedKeys[prompt.tool] ?? []);
  if (spec) {
    view.fields.push(...(spec.combine?.(record) ?? []));
    for (const field of spec.fields) {
      used.add(field.key);
      const value = displayValue(record[field.key]);
      if (value) view.fields.push({ label: field.label, value });
      else if (field.always) view.fields.push({ label: field.label, value: field.empty ?? '(none)' });
    }
    for (const block of spec.blocks) {
      used.add(block.key);
      const text = displayValue(record[block.key]);
      if (text) view.blocks.push({ label: block.label, text });
    }
  }
  const rest = Object.keys(record).filter((key) => !used.has(key));
  if (rest.length) {
    view.blocks.push({ label: spec ? 'Other details' : 'Details', text: rest.map((key) => `${key}: ${displayValue(record[key])}`).join('\n') });
  }
  return view;
}

export function parseToolApprovalPrompt(payload: unknown): ToolApprovalPrompt | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const requestId = text(record.requestId);
  const tool = text(record.tool);
  if (!requestId || !tool) return null;
  return {
    requestId,
    tool,
    summary: text(record.summary),
    connector: text(record.connector),
    args: record.args ?? null,
    argsTruncated: record.argsTruncated === true,
    sessionId: text(record.sessionId),
    conversationTitle: text(record.conversationTitle) || null,
    agentName: text(record.agentName) || null,
  };
}

/** Prompts from `desktop_tool_approval_pending`; the native list is authoritative. */
export function parsePendingToolApprovals(payload: unknown): ToolApprovalPrompt[] {
  if (!Array.isArray(payload)) return [];
  return payload.map(parseToolApprovalPrompt).filter((prompt): prompt is ToolApprovalPrompt => prompt !== null);
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
