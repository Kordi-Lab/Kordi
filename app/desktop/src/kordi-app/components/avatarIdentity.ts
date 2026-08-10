import { useSyncExternalStore } from 'react';

import { migrateAvatarOverride } from './avatarOverrides';

const LOCAL_PROFILE_AVATAR_SEED_KEY = 'kordi.localProfileAvatarSeed.v1';
const LOCAL_PROFILE_IDENTITY_SEED_KEY = 'kordi.localProfileIdentitySeed.v1';
const LOCAL_AGENT_IDENTITY_SEED_KEY = 'kordi.localAgentIdentitySeed.v1';
const LOCAL_AVATAR_SEEDS_CHANGE_EVENT = 'kordi-local-avatar-seeds-change';

let localProfileAvatarSeedSnapshot: string | null = null;
let localAgentAvatarSeedSnapshot: string | null = null;

function browserAvatarScope() {
  if (typeof window === 'undefined') return 'desktop';
  return window.location.origin || 'desktop';
}

function readLocalStorageValue(key: string) {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key)?.trim() || null;
  } catch {
    return null;
  }
}

function writeLocalStorageValue(key: string, value?: string | null) {
  if (typeof window === 'undefined') return;
  const normalized = value?.trim();
  if (!normalized) return;
  try {
    window.localStorage.setItem(key, normalized);
  } catch {
    // Ignore storage failures; deterministic fallbacks keep generated avatars stable.
  }
}

function emitLocalAvatarSeedsChange() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new window.Event(LOCAL_AVATAR_SEEDS_CHANGE_EVENT));
}

function subscribeLocalAvatarSeeds(onStoreChange: () => void) {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(LOCAL_AVATAR_SEEDS_CHANGE_EVENT, onStoreChange);
  window.addEventListener('storage', onStoreChange);
  return () => {
    window.removeEventListener(LOCAL_AVATAR_SEEDS_CHANGE_EVENT, onStoreChange);
    window.removeEventListener('storage', onStoreChange);
  };
}

export function getLocalProfileAvatarSeed() {
  if (localProfileAvatarSeedSnapshot?.trim()) return localProfileAvatarSeedSnapshot;

  const identitySeed = readLocalStorageValue(LOCAL_PROFILE_IDENTITY_SEED_KEY);
  if (identitySeed) return identitySeed;

  const legacySeed = readLocalStorageValue(LOCAL_PROFILE_AVATAR_SEED_KEY);
  if (legacySeed) return `local-human-profile:${browserAvatarScope()}:${legacySeed}`;

  return `local-human-profile:${browserAvatarScope()}`;
}

export function setLocalProfileAvatarSeed(seed?: string | null) {
  const normalized = seed?.trim();
  if (!normalized || normalized === localProfileAvatarSeedSnapshot) return;
  localProfileAvatarSeedSnapshot = normalized;
  writeLocalStorageValue(LOCAL_PROFILE_IDENTITY_SEED_KEY, normalized);
  emitLocalAvatarSeedsChange();
}

export function useLocalProfileAvatarSeed() {
  return useSyncExternalStore(
    subscribeLocalAvatarSeeds,
    getLocalProfileAvatarSeed,
    () => 'local-human-profile',
  );
}

export function getPersistedLocalAgentAvatarSeed() {
  if (localAgentAvatarSeedSnapshot?.trim()) return localAgentAvatarSeedSnapshot;
  return readLocalStorageValue(LOCAL_AGENT_IDENTITY_SEED_KEY);
}

export function getLocalAgentAvatarSeed(_label?: string | null) {
  const identitySeed = getPersistedLocalAgentAvatarSeed();
  if (identitySeed) return identitySeed;

  // UI labels vary between surfaces ("Kordi", "My Kordi", a session title,
  // or a runtime label). They are presentation, not identity, so they must
  // never influence the generated avatar.
  return `local-agent:${browserAvatarScope()}:kordi`;
}

export function setLocalAgentAvatarSeed(seed?: string | null) {
  const normalized = seed?.trim();
  if (!normalized || normalized === localAgentAvatarSeedSnapshot) return;
  const previous = getPersistedLocalAgentAvatarSeed();
  if (previous && previous !== normalized) {
    migrateAvatarOverride(`agent:${previous}`, `agent:${normalized}`);
  }
  localAgentAvatarSeedSnapshot = normalized;
  writeLocalStorageValue(LOCAL_AGENT_IDENTITY_SEED_KEY, normalized);
  emitLocalAvatarSeedsChange();
}

export function useLocalAgentAvatarSeed(_label?: string | null) {
  return useSyncExternalStore(
    subscribeLocalAvatarSeeds,
    getLocalAgentAvatarSeed,
    () => 'local-agent:desktop:kordi',
  );
}

export function getIdentityAvatarKey(kind: string, seed: string, avatarKey?: string | null) {
  return avatarKey?.trim() || `${kind}:${seed.trim() || 'unknown'}`;
}
