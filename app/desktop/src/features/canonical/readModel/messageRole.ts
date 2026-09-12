import type { CanonicalIdentity, CanonicalSessionMessage, Message } from '@/kordi-app/types';

export function canonicalMessageRole(
  message: CanonicalSessionMessage,
  identity?: CanonicalIdentity,
  profileHumanIdentityId?: string | null,
): Message['role'] {
  const senderRole = message.senderRole;
  if (message.messageKind === 'agent-model-change') return 'system';
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
