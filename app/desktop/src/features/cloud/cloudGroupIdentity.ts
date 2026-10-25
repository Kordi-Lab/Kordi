import type { UpsertCanonicalIdentityRequest } from '@/kordi-app/types';

import { cloudAvatarImageUrl, cloudAvatarSeedForAccount } from './avatar';
import type { CloudAccount, CloudPublicProfile } from './authClient';
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

export type CloudGroupAgentAvatar = Pick<CloudGroupParticipant, 'accountId' | 'agentId' | 'agentAvatarUrl'>;

const MAX_AGENT_AVATAR_URL_LENGTH = 256 * 1024;

/**
 * Each member's default agent picture. The participant snapshot carries no agent fields, so
 * this is kept apart from it; profiles win over envelope values, as in
 * `cloudGroupParticipantsWithProfiles`.
 */
export function cloudGroupAgentAvatarsByAccount(
  participants: readonly CloudGroupParticipant[],
  profiles: readonly Pick<CloudPublicProfile, 'accountId' | 'defaultAgent'>[],
): Map<string, CloudGroupAgentAvatar> {
  const avatars = new Map<string, CloudGroupAgentAvatar>();
  const add = (accountId: string, agentId?: string | null, agentAvatarUrl?: string | null) => {
    const id = accountId.trim();
    const url = agentAvatarUrl?.trim();
    if (!id || !url || url.length > MAX_AGENT_AVATAR_URL_LENGTH || avatars.has(id)) return;
    avatars.set(id, { accountId: id, agentId: agentId?.trim() || null, agentAvatarUrl: url });
  };
  for (const profile of profiles) add(profile.accountId, profile.defaultAgent?.agentId, profile.defaultAgent?.avatarUrl);
  for (const participant of participants) add(participant.accountId, participant.agentId, participant.agentAvatarUrl);
  return avatars;
}

/** The picture a member configured for their default agent, for that agent's replies only. */
export function cloudGroupAgentProfileImageUrl(
  participant: CloudGroupAgentAvatar | null | undefined,
  senderAgentId: string,
): string | null {
  if (!participant) return null;
  const memberAgentId = cloudAgentId(participant.agentId, participant.accountId);
  return memberAgentId === senderAgentId ? cloudAvatarImageUrl(participant.agentAvatarUrl) : null;
}
