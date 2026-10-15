import type { UpsertCanonicalIdentityRequest } from '@/kordi-app/types';

import { cloudAvatarImageUrl, cloudAvatarSeedForAccount } from './avatar';
import type { CloudAccount } from './authClient';
import { cloudAgentId } from './cloudAgentIdentity';
import { CLOUD_HOST_SENTINEL } from './cloudContactMapping';
import type { CloudGroupParticipant } from './cloudGroupMessages';
import { normalizeKordiId } from './kordiId';

export function cloudGroupIdentityRequest(
  participant: CloudGroupParticipant,
  account: CloudAccount,
  _localHumanIdentityId: string,
): UpsertCanonicalIdentityRequest {
  const isSelf = participant.accountId === account.accountId;
  const id = `human:${participant.accountId}`;
  return {
    id,
    kind: 'human',
    displayName: participant.displayName,
    source: isSelf ? 'local' : 'cloud',
    sourceHostId: isSelf ? null : CLOUD_HOST_SENTINEL,
    sourceIdentityId: isSelf ? null : participant.accountId,
    humanId: participant.accountId,
    agentId: null,
    avatarKey: cloudAvatarSeedForAccount(participant.accountId, participant.avatarUrl),
    profileImageUrl: cloudAvatarImageUrl(participant.avatarUrl),
    metadata: {
      accountId: participant.accountId,
      kordiId: normalizeKordiId(participant.kordiId),
      cloudGroupParticipant: true,
      defaultAgentId: participant.agentId ?? `cloud-agent:${participant.accountId}`,
      defaultAgentDisplayName: participant.agentDisplayName ?? 'Kordi',
      defaultAgentAvatarUrl: participant.agentAvatarUrl ?? null,
      defaultAgentAvatarSeed: participant.agentAvatarSeed ?? participant.agentId ?? `cloud-agent:${participant.accountId}`,
    },
  };
}

/** The picture a member configured for their default agent, for that agent's replies only. */
export function cloudGroupAgentProfileImageUrl(
  participant: Pick<CloudGroupParticipant, 'accountId' | 'agentId' | 'agentAvatarUrl'> | null | undefined,
  senderAgentId: string,
): string | null {
  if (!participant) return null;
  const memberAgentId = cloudAgentId(participant.agentId, participant.accountId);
  return memberAgentId === senderAgentId ? cloudAvatarImageUrl(participant.agentAvatarUrl) : null;
}
