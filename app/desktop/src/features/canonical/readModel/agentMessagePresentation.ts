import type { CanonicalIdentity } from '@/kordi-app/types';
import { selfDisplayName, stripSelfPossessivePrefix } from '@/lib/identityLabels';

export function ownerScopedAgentName(
  identity: CanonicalIdentity | undefined,
  identityById: Map<string, CanonicalIdentity>,
  profileHumanIdentityId?: string | null,
) {
  if (!identity) return undefined;
  if (identity.kind !== 'agent') return selfDisplayName(identity.displayName, identity.id === profileHumanIdentityId);
  const owner = identity.ownerIdentityId ? identityById.get(identity.ownerIdentityId) : undefined;
  return stripSelfPossessivePrefix(identity.displayName, owner?.displayName) || identity.displayName;
}

export function agentMessagePresentation(
  identity: CanonicalIdentity | undefined,
  identityById: Map<string, CanonicalIdentity>,
  profileHumanIdentityId: string | null | undefined,
  contentSender: string | undefined,
  contentOwnerName: string | undefined,
  isAgentTurn: boolean,
) {
  const owner = identity?.kind === 'agent' && identity.ownerIdentityId
    ? identityById.get(identity.ownerIdentityId)
    : undefined;
  const localIdentitySender = identity?.kind === 'agent'
    && identity.source === 'local'
    && /^(?:my\s+)?kordi$/iu.test(contentSender ?? '')
    ? identity.displayName?.trim()
    : null;
  return {
    sender: localIdentitySender || contentSender || identity?.displayName,
    senderOwnerName: isAgentTurn
      ? contentOwnerName?.trim() || (owner?.id === profileHumanIdentityId ? 'You' : owner?.displayName?.trim()) || null
      : null,
  };
}
