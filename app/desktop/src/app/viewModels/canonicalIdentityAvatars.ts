import type { CanonicalSessionState } from '@/kordi-app/types';

export function canonicalAvatarSeed(state: CanonicalSessionState | null | undefined, identityId?: string | null) {
  const id = identityId?.trim();
  if (!state || !id) return null;
  return state.identities.find((identity) => identity.id === id)?.avatarKey?.trim() || null;
}

export function canonicalProfileImageUrl(state: CanonicalSessionState | null | undefined, identityId?: string | null) {
  const id = identityId?.trim();
  if (!state || !id) return null;
  return state.identities.find((identity) => identity.id === id)?.profileImageUrl?.trim() || null;
}

export function canonicalLocalAgentIdentity(state: CanonicalSessionState | null | undefined) {
  if (!state) return null;
  const profileHumanIdentityId = state.profile.humanIdentityId?.trim();
  if (!profileHumanIdentityId) return null;
  const ownedLocalAgents = state.identities.filter((identity) => (
    identity.kind === 'agent'
    && identity.source === 'local'
    && identity.ownerIdentityId === profileHumanIdentityId
  ));
  const profileDelegates = ownedLocalAgents.filter((identity) => {
    const metadata = identity.metadata && typeof identity.metadata === 'object' && !Array.isArray(identity.metadata)
      ? identity.metadata as Record<string, unknown>
      : null;
    return metadata?.profileId === state.profile.id && metadata.delegateAgentName === 'Kordi';
  });
  const candidates = profileDelegates.length > 0 ? profileDelegates : ownedLocalAgents;
  const activeAgentIdentityId = state.profile.activeAgentIdentityId?.trim();
  const activeIdentity = activeAgentIdentityId
    ? candidates.find((identity) => identity.id === activeAgentIdentityId)
    : null;
  if (activeIdentity) return activeIdentity;
  return candidates[0] ?? null;
}

export function canonicalLocalAgentAvatarSeed(state: CanonicalSessionState | null | undefined) {
  return canonicalLocalAgentIdentity(state)?.avatarKey?.trim() || null;
}

export function canonicalLocalAgentProfileImageUrl(state: CanonicalSessionState | null | undefined) {
  const agentProfileImageUrl = canonicalLocalAgentIdentity(state)?.profileImageUrl?.trim() || null;
  const humanProfileImageUrl = canonicalProfileImageUrl(state, state?.profile.humanIdentityId);
  return agentProfileImageUrl && agentProfileImageUrl !== humanProfileImageUrl
    ? agentProfileImageUrl
    : null;
}

export function localAgentConversationAvatarFields(
  localAgentLabel: string,
  localHumanAvatarSeed: string,
  localAgentAvatarSeed: string,
  localAgentProfileImageUrl: string | null,
) {
  return {
    participants: ['Me', 'My Kordi'],
    participantAvatarSeeds: {
      Me: localHumanAvatarSeed,
      You: localHumanAvatarSeed,
      [localAgentLabel]: localAgentAvatarSeed,
      'My Kordi': localAgentAvatarSeed,
      Kordi: localAgentAvatarSeed,
    },
    participantProfileImageUrls: {
      [localAgentLabel]: localAgentProfileImageUrl,
      'My Kordi': localAgentProfileImageUrl,
      Kordi: localAgentProfileImageUrl,
    },
    profileImageUrl: localAgentProfileImageUrl,
    avatarSeed: localAgentAvatarSeed,
  };
}
