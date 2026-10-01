import type { CanonicalIdentity, CanonicalSessionMessage, Message } from '@/kordi-app/types';

/** Server-set kind of the notice an AI access change posts. Only the server
 * can create it, so it is recognized by the stored message kind alone. */
export const AI_ACCESS_NOTICE_MESSAGE_KIND = 'ai-access-notice';

export function canonicalMessageRole(
  message: CanonicalSessionMessage,
  identity?: CanonicalIdentity,
  profileHumanIdentityId?: string | null,
): Message['role'] {
  const { senderRole, messageKind } = message;
  if (messageKind === 'agent-model-change' || messageKind === AI_ACCESS_NOTICE_MESSAGE_KIND) return 'system';
  if (['system', 'user', 'owned-agent', 'external-agent', 'person'].includes(senderRole)) {
    if (
      senderRole === 'external-agent'
      && identity?.kind === 'agent'
      && identity.ownerIdentityId === profileHumanIdentityId?.trim()
    ) return 'owned-agent';
    return senderRole as Message['role'];
  }
  if (identity?.kind === 'agent') return identity.source === 'local' ? 'owned-agent' : 'external-agent';
  return 'person';
}
