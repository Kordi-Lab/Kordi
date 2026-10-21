import { isSystemNoticeKind } from './systemNotice';
import type { CanonicalIdentity, CanonicalSessionMessage, Message } from '@/kordi-app/types';

export function canonicalMessageRole(
  message: CanonicalSessionMessage,
  identity?: CanonicalIdentity,
  profileHumanIdentityId?: string | null,
): Message['role'] {
  const { senderRole, messageKind } = message;
  if (messageKind === 'agent-model-change') return 'system';
  if (isSystemNoticeKind(messageKind)) return 'person'; // Server notices keep the multi-line bubble.
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
