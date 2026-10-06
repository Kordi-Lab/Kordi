import type { CanonicalSessionMessage } from '@/kordi-app/types';
import { isExplicitPlaceholderSessionTitle } from '@/features/chat/sessionTitlePolicy';
import { parseCloudDirectMessageEnvelope } from '@/features/cloud/cloudDirectMessages';
import { isCloudAgentControlMessage } from '@/features/cloud/cloudAgentMessages';

function contentRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Content marker on a failed request that was sent again; the retried send replaces it in the transcript. */
export const RETIRED_BY_RETRY_CONTENT_KEY = 'retiredByRetry';

/**
 * Only a failed row can be retired, so callers pass the status they already read and every other row
 * costs no extra property reads.
 */
export function isRetiredFailedRequest(message: CanonicalSessionMessage, normalizedStatus: string) {
  return normalizedStatus === 'failed' && contentRecord(message.content)[RETIRED_BY_RETRY_CONTENT_KEY] === true;
}

export function isPlaceholderSessionTitleNotice(message: CanonicalSessionMessage) {
  if (message.messageKind !== 'status') return false;
  const content = contentRecord(message.content);
  return content.kind === 'session-title-update'
    && content.scope === 'session'
    && typeof content.title === 'string'
    && isExplicitPlaceholderSessionTitle(content.title);
}

export function isSynchronizationOnlyCloudGroupTitleNotice(message: CanonicalSessionMessage) {
  if (message.messageKind !== 'status' || message.sourceTransport !== 'cloud-group-title-update') return false;
  const content = contentRecord(message.content);
  return content.kind === 'group-title-update'
    && content.scope === 'group'
    && content.synchronizationOnly === true
    && (content.sourceControlKind === 'group-invite' || content.sourceControlKind === 'group-update');
}

export function isInternalCloudAgentControlMessage(message: CanonicalSessionMessage) {
  const text = message.contentText.trim();
  const content = contentRecord(message.content);
  const normalized = content.schemaVersion === 1 && content.kind === 'message';
  const envelope = normalized ? null : parseCloudDirectMessageEnvelope(text);
  return content.synchronizationOnly === true
    || envelope?.synchronizationOnly === true
    || (Boolean(envelope) && message.messageKind === 'agent-model-change')
    || (!normalized && isCloudAgentControlMessage(text));
}

export function canonicalMessageCountsAsReadable(message: CanonicalSessionMessage) {
  if (message.sourceTransport === 'canonical-fork-snapshot') return false;
  const status = message.status.trim().toLowerCase();
  if (['sending', 'processing'].includes(status)) return false;
  return !isPlaceholderSessionTitleNotice(message)
    && !isRetiredFailedRequest(message, status)
    && !isSynchronizationOnlyCloudGroupTitleNotice(message)
    && !isInternalCloudAgentControlMessage(message);
}
