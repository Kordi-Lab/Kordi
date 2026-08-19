import type { CanonicalIdentity, CanonicalSessionState } from '@/kordi-app/types';

export const DEFAULT_LOCAL_AGENT_AVATAR_SEED = 'cloud-local-agent';

export function canonicalIdentityAvatarSeed(identity: CanonicalIdentity | undefined) {
  if (!identity) return null;
  if (identity.kind === 'agent' && identity.source === 'local') {
    return DEFAULT_LOCAL_AGENT_AVATAR_SEED;
  }
  return identity.kind === 'agent'
    ? identity.agentId?.trim() || identity.avatarKey
    : identity.avatarKey;
}

export function canonicalLocalAgentAvatarSeed(state: CanonicalSessionState | null | undefined) {
  if (!state) return null;
  return canonicalIdentityAvatarSeed(state.identities.find((identity) => (
    identity.kind === 'agent' && identity.id === state.profile.activeAgentIdentityId
  )));
}
