import type { CanonicalSessionMessage } from '@/kordi-app/types';
import { isExplicitPlaceholderSessionTitle } from '@/features/chat/sessionTitlePolicy';

function contentRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
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

export function canonicalMessageCountsAsReadable(message: CanonicalSessionMessage) {
  if (['canonical-fork-snapshot', 'cloud-group-fork-snapshot'].includes(message.sourceTransport ?? '')) return false;
  if (['sending', 'processing'].includes(message.status.trim().toLowerCase())) return false;
  return !isPlaceholderSessionTitleNotice(message)
    && !isSynchronizationOnlyCloudGroupTitleNotice(message);
}
