import type { CanonicalIdentity } from '@/kordi-app/types';
import { defaultAgentDisplayName, selfDisplayName, stripSelfPossessivePrefix } from '@/lib/identityLabels';
import { cloudAgentId, defaultCloudAgentId } from '@/features/cloud/cloudAgentIdentity';

function isDefaultAgent(identity: CanonicalIdentity | undefined, owner: CanonicalIdentity | undefined) {
  const ownerId = identity?.humanId?.trim() || owner?.humanId?.trim();
  return Boolean(ownerId && identity?.kind === 'agent' && identity.agentId?.trim()
    && cloudAgentId(identity.agentId, ownerId) === defaultCloudAgentId(ownerId));
}

export function ownerScopedAgentName(
  identity: CanonicalIdentity | undefined,
  identityById: Map<string, CanonicalIdentity>,
  profileHumanIdentityId?: string | null,
) {
  if (!identity) return undefined;
  if (identity.kind !== 'agent') return selfDisplayName(identity.displayName, identity.id === profileHumanIdentityId);
  const owner = identity.ownerIdentityId ? identityById.get(identity.ownerIdentityId) : undefined;
  if (isDefaultAgent(identity, owner)) return defaultAgentDisplayName(owner?.displayName, identity.displayName);
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
    sender: isDefaultAgent(identity, owner)
      ? defaultAgentDisplayName(owner?.displayName || contentOwnerName, localIdentitySender || contentSender || identity?.displayName)
      : localIdentitySender || contentSender || identity?.displayName,
    senderOwnerName: isAgentTurn
      ? contentOwnerName?.trim() || (owner?.id === profileHumanIdentityId ? 'You' : owner?.displayName?.trim()) || null
      : null,
  };
}
