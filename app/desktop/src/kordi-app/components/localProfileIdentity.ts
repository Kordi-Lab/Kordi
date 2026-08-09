import { useSyncExternalStore } from 'react';

export type ActiveLocalProfileIdentity = Readonly<{
  avatarSeed: string | null;
  displayName: string | null;
  profileImageUrl: string | null;
  agentAvatarSeed: string | null;
  agentProfileImageUrl: string | null;
}>;

type IdentityAvatarPresentationInput = {
  kind: 'human' | 'agent';
  seed: string;
  name?: string | null;
  imageUrl?: string | null;
  isSelf?: boolean;
  activeLocalProfileIdentity?: ActiveLocalProfileIdentity;
};

const ACTIVE_LOCAL_PROFILE_IDENTITY_CHANGE_EVENT =
  'kordi-active-local-profile-identity-change';

const EMPTY_ACTIVE_LOCAL_PROFILE_IDENTITY: ActiveLocalProfileIdentity = {
  avatarSeed: null,
  displayName: null,
  profileImageUrl: null,
  agentAvatarSeed: null,
  agentProfileImageUrl: null,
};

let activeLocalProfileIdentitySnapshot = EMPTY_ACTIVE_LOCAL_PROFILE_IDENTITY;

function subscribeActiveLocalProfileIdentity(onStoreChange: () => void) {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(
    ACTIVE_LOCAL_PROFILE_IDENTITY_CHANGE_EVENT,
    onStoreChange,
  );
  return () => {
    window.removeEventListener(
      ACTIVE_LOCAL_PROFILE_IDENTITY_CHANGE_EVENT,
      onStoreChange,
    );
  };
}

export function getActiveLocalProfileIdentity() {
  return activeLocalProfileIdentitySnapshot;
}

export function setActiveLocalProfileIdentity({
  avatarSeed,
  displayName,
  profileImageUrl,
  agentAvatarSeed,
  agentProfileImageUrl,
}: Partial<ActiveLocalProfileIdentity>) {
  const next: ActiveLocalProfileIdentity = {
    avatarSeed: avatarSeed?.trim() || null,
    displayName: displayName?.trim() || null,
    profileImageUrl: profileImageUrl?.trim() || null,
    agentAvatarSeed: agentAvatarSeed?.trim() || null,
    agentProfileImageUrl: agentProfileImageUrl?.trim() || null,
  };
  if (
    next.avatarSeed === activeLocalProfileIdentitySnapshot.avatarSeed
    && next.displayName === activeLocalProfileIdentitySnapshot.displayName
    && next.profileImageUrl
      === activeLocalProfileIdentitySnapshot.profileImageUrl
    && next.agentAvatarSeed
      === activeLocalProfileIdentitySnapshot.agentAvatarSeed
    && next.agentProfileImageUrl
      === activeLocalProfileIdentitySnapshot.agentProfileImageUrl
  ) return;

  activeLocalProfileIdentitySnapshot = next;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new window.Event(ACTIVE_LOCAL_PROFILE_IDENTITY_CHANGE_EVENT),
    );
  }
}

export function useActiveLocalProfileIdentity() {
  return useSyncExternalStore(
    subscribeActiveLocalProfileIdentity,
    getActiveLocalProfileIdentity,
    () => EMPTY_ACTIVE_LOCAL_PROFILE_IDENTITY,
  );
}

export function resolveIdentityAvatarPresentation({
  kind,
  seed,
  name,
  imageUrl,
  isSelf = false,
  activeLocalProfileIdentity = EMPTY_ACTIVE_LOCAL_PROFILE_IDENTITY,
}: IdentityAvatarPresentationInput) {
  const normalizedSeed = (
    isSelf
      ? activeLocalProfileIdentity.avatarSeed?.trim() || seed.trim()
      : seed.trim()
  ) || name?.trim() || `${kind}:unknown`;
  const fallbackLabel = (
    isSelf
      ? activeLocalProfileIdentity.displayName?.trim() || name?.trim()
      : name?.trim()
  ) || normalizedSeed;
  const isActiveLocalAgent = kind === 'agent'
    && normalizedSeed === activeLocalProfileIdentity.agentAvatarSeed?.trim();
  const resolvedImageUrl = isSelf
    ? activeLocalProfileIdentity.profileImageUrl?.trim() || imageUrl
    : isActiveLocalAgent
      ? activeLocalProfileIdentity.agentProfileImageUrl?.trim() || imageUrl
      : imageUrl;
  return { fallbackLabel, normalizedSeed, resolvedImageUrl };
}
