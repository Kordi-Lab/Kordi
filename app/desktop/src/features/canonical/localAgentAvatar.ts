import type { CloudAccount } from '@/features/cloud/cloudIdentityTypes';
import { canonicalAvatarImageSource } from '@/features/cloud/canonicalAvatar';

/** Generated seed for the local agent when no cloud account is signed in. */
export const DEFAULT_LOCAL_AGENT_AVATAR_SEED = 'cloud-local-agent';

/**
 * The avatar of the signed-in user's own agent. While a cloud account is signed
 * in it mirrors the account's default agent avatar as the server reports it, so
 * live turns, stored messages and other devices all show one picture.
 */
export type LocalAgentAvatar = Readonly<{
  accountId: string | null;
  seed: string;
  imageUrl: string | null;
}>;

export type LocalAgentAvatarInput = {
  accountId?: string | null;
  seed?: string | null;
  imageUrl?: string | null;
};

const LOCAL_AGENT_AVATAR_CHANGE_EVENT = 'kordi-local-agent-avatar-change';

export const SIGNED_OUT_LOCAL_AGENT_AVATAR: LocalAgentAvatar = {
  accountId: null,
  seed: DEFAULT_LOCAL_AGENT_AVATAR_SEED,
  imageUrl: null,
};

let localAgentAvatarSnapshot: LocalAgentAvatar = SIGNED_OUT_LOCAL_AGENT_AVATAR;

/** The server generates an account's default agent avatar from this seed. */
export function accountDefaultAgentAvatarSeed(accountId: string | null | undefined) {
  const id = accountId?.trim();
  return id && /^[A-Za-z0-9_-]+$/.test(id) ? `default-agent-${id}` : null;
}

export function localAgentAvatarFromAccount(
  account: Pick<CloudAccount, 'accountId' | 'defaultAgent'> | null | undefined,
): LocalAgentAvatarInput | null {
  const accountId = account?.accountId?.trim();
  if (!accountId) return null;
  const avatar = account?.defaultAgent?.avatar;
  let imageUrl: string | null = null;
  try {
    imageUrl = avatar ? canonicalAvatarImageSource(avatar) : null;
  } catch {
    imageUrl = null;
  }
  return {
    accountId,
    seed: avatar?.seed?.trim() || accountDefaultAgentAvatarSeed(accountId),
    imageUrl: imageUrl || account?.defaultAgent?.avatarUrl?.trim() || null,
  };
}

export function getLocalAgentAvatar() {
  return localAgentAvatarSnapshot;
}

export function setLocalAgentAvatar(input: LocalAgentAvatarInput | null | undefined) {
  const accountId = input?.accountId?.trim() || null;
  const next: LocalAgentAvatar = accountId
    ? {
        accountId,
        seed: input?.seed?.trim() || accountDefaultAgentAvatarSeed(accountId) || DEFAULT_LOCAL_AGENT_AVATAR_SEED,
        imageUrl: input?.imageUrl?.trim() || null,
      }
    : SIGNED_OUT_LOCAL_AGENT_AVATAR;
  const current = localAgentAvatarSnapshot;
  if (next.accountId === current.accountId && next.seed === current.seed && next.imageUrl === current.imageUrl) return;
  localAgentAvatarSnapshot = next;
  if (typeof window !== 'undefined') window.dispatchEvent(new window.Event(LOCAL_AGENT_AVATAR_CHANGE_EVENT));
}

export function subscribeLocalAgentAvatar(onStoreChange: () => void) {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(LOCAL_AGENT_AVATAR_CHANGE_EVENT, onStoreChange);
  return () => window.removeEventListener(LOCAL_AGENT_AVATAR_CHANGE_EVENT, onStoreChange);
}

/** True when an agent avatar seed names the signed-in user's own agent. */
export function isLocalAgentAvatarSeed(seed: string | null | undefined, avatar: LocalAgentAvatar = localAgentAvatarSnapshot) {
  const value = seed?.trim();
  if (!value) return false;
  return value === DEFAULT_LOCAL_AGENT_AVATAR_SEED
    || value === avatar.seed
    || (avatar.accountId !== null && value === accountDefaultAgentAvatarSeed(avatar.accountId));
}

/** Maps any seed that names the user's own agent to the account's agent avatar seed. */
export function resolveLocalAgentAvatarSeed(seed: string, avatar: LocalAgentAvatar = localAgentAvatarSnapshot) {
  return isLocalAgentAvatarSeed(seed, avatar) ? avatar.seed : seed;
}
