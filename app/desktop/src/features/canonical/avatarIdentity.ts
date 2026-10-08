import type { CanonicalIdentity, CanonicalSessionState } from '@/kordi-app/types';
import { getLocalAgentAvatar } from './localAgentAvatar';

export { DEFAULT_LOCAL_AGENT_AVATAR_SEED } from './localAgentAvatar';

const CLOUD_DEFAULT_AGENT_ID_PATTERN = /^cloud-(?:agent|self):([A-Za-z0-9_-]+)$/;

// The cloud server generates an account's default agent avatar from
// `default-agent-<account id>`; `cloud-agent:<account id>` is not a valid seed.
export function cloudDefaultAgentAvatarSeed(agentId: string | null | undefined) {
  const match = agentId?.trim().match(CLOUD_DEFAULT_AGENT_ID_PATTERN);
  const accountId = match?.[1];
  if (!accountId || accountId.startsWith('cloud_agent_')) return null;
  return `default-agent-${accountId}`;
}

export function canonicalIdentityAvatarSeed(identity: CanonicalIdentity | undefined) {
  if (!identity) return null;
  // The local agent is the signed-in account's own default agent.
  if (identity.kind === 'agent' && identity.source === 'local') {
    return getLocalAgentAvatar().seed;
  }
  if (identity.kind !== 'agent') return identity.avatarKey;
  const agentId = identity.agentId?.trim();
  return cloudDefaultAgentAvatarSeed(agentId) ?? (agentId || identity.avatarKey);
}

export function canonicalLocalAgentAvatarSeed(state: CanonicalSessionState | null | undefined) {
  if (!state) return null;
  return canonicalIdentityAvatarSeed(state.identities.find((identity) => (
    identity.kind === 'agent' && identity.id === state.profile.activeAgentIdentityId
  )));
}
