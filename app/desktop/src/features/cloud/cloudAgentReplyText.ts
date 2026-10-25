import type { DesktopChatToolSnapshot, DesktopChatTurnSnapshot } from '@/kordi-app/types';

import { isCloudAgentStoredNoProviderFailure } from './cloudAgentMessages';

/** Provider failure notices and raw provider errors are one short line. */
const PROVIDER_FAILURE_NOTICE_MAX_LENGTH = 240;

/**
 * Whether reply text is itself a provider failure notice, such as "No provider configured yet."
 * or a raw "no credentials" error that an older build stored as the reply. A real answer that
 * only mentions the notice, for example a report about earlier failures, is not one.
 */
export function isCloudAgentProviderFailureNoticeText(value: string | null | undefined): boolean {
  const text = value?.trim() ?? '';
  if (!text || text.length > PROVIDER_FAILURE_NOTICE_MAX_LENGTH || /[\r\n]/.test(text)) return false;
  return isCloudAgentStoredNoProviderFailure(text);
}

/** Whether a failed reply's text is only its error sentence, so the failure line should not repeat it. */
export function isFailedReplyTextOnlyItsError(text: string | null | undefined, error: string | null | undefined): boolean {
  const normalize = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const reply = normalize(text);
  return reply !== '' && reply === normalize(error);
}

/** Whether a stored reply carries what a run produced: tool calls or attached files. */
export function cloudAgentStoredReplyHasRunOutput(content: Record<string, unknown>): boolean {
  return [content.tools, content.attachments].some((value) => Array.isArray(value) && value.length > 0);
}

/**
 * Whether a stored agent reply shows as a provider failure. A failed reply is matched on its text
 * or error. A reply that did not fail is a real answer unless its whole text is the notice, and a
 * reply with run output (tools or files) never is: a run that has no provider produces nothing.
 */
export function isCloudAgentStoredNoProviderReply(input: {
  text?: string | null;
  error?: string | null;
  detail?: string | null;
  failed: boolean;
  hasRunOutput?: boolean;
}): boolean {
  const text = input.text?.trim() ?? '';
  if (input.failed) return isCloudAgentStoredNoProviderFailure(text || input.error || input.detail);
  if (input.hasRunOutput) return false;
  return text
    ? isCloudAgentProviderFailureNoticeText(text)
    : isCloudAgentStoredNoProviderFailure(input.error || input.detail);
}

function createdDocumentTitle(tool: DesktopChatToolSnapshot): string | null {
  if (tool.name !== 'create_document' || tool.isError) return null;
  try {
    const result = JSON.parse(tool.resultText ?? '') as { created?: unknown; title?: unknown; fileName?: unknown };
    if (result.created === false) return null;
    const title = typeof result.title === 'string' ? result.title.trim() : '';
    const fileName = typeof result.fileName === 'string' ? result.fileName.trim() : '';
    return title || fileName || null;
  } catch {
    return null;
  }
}

/**
 * The text a finished turn replies with. A model can end on a tool call with no closing words;
 * when that call created a document, the reply names the document instead of failing.
 */
export function cloudAgentTurnReplyText(
  turn: Pick<DesktopChatTurnSnapshot, 'succeeded' | 'assistantText' | 'tools'>,
): string {
  if (!turn.succeeded) return '';
  const text = turn.assistantText.trim();
  if (text) return text;
  const titles = [...new Set(turn.tools.map(createdDocumentTitle).filter((title): title is string => Boolean(title)))];
  if (titles.length === 0) return '';
  return `Created ${titles.map((title) => `“${title}”`).join(', ')}.`;
}
