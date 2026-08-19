import { useState, useSyncExternalStore } from 'react';

import { Avatar } from '@/components/ui/avatar';
import {
  cloudSignupAvatarBackground,
  cloudSignupAvatarInitials,
  cloudSignupAvatarPalette,
} from '@/features/cloud/signupAvatar';
import {
  AGENT_CANONICAL_AVATAR_STYLE,
  canonicalAvatarImageUrl,
  generatedAvatarPreviewUrl,
} from '@/features/cloud/canonicalAvatar';
import {
  DEFAULT_LOCAL_AGENT_AVATAR_SEED,
} from '@/features/canonical/avatarIdentity';
import { cn } from '@/lib/utils';
import { useAvatarOverride } from './avatarOverrides';
import {
  resolveIdentityAvatarPresentation,
  useActiveLocalProfileIdentity,
} from './localProfileIdentity';
import { shouldLoadAvatarThroughNativeProxy, useRemoteAvatarImage } from './remoteAvatarImage';

export type IdentityAvatarKind = 'human' | 'agent';

export type IdentityAvatarProps = {
  kind: IdentityAvatarKind;
  seed: string;
  /** Resolve the visual identity from the signed-in profile, even when the UI label is "Me" or "You". */
  isSelf?: boolean;
  name?: string | null;
  imageUrl?: string | null;
  avatarKey?: string | null;
  className?: string;
  generatedClassName?: string;
  presenceStatus?: 'online' | 'offline' | string | null;
  presenceLabel?: string | null;
};

const LOCAL_PROFILE_AVATAR_SEED_KEY = 'kordi.localProfileAvatarSeed.v1';
const LOCAL_PROFILE_IDENTITY_SEED_KEY = 'kordi.localProfileIdentitySeed.v1';
const LOCAL_AVATAR_SEEDS_CHANGE_EVENT = 'kordi-local-avatar-seeds-change';

let localProfileAvatarSeedSnapshot: string | null = null;

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

export function getLocalAgentAvatarSeed() {
  return DEFAULT_LOCAL_AGENT_AVATAR_SEED;
}

export function useLocalAgentAvatarSeed() {
  return DEFAULT_LOCAL_AGENT_AVATAR_SEED;
}

function HumanInitialsAvatar({ label, className }: { label: string; className?: string }) {
  const palette = cloudSignupAvatarPalette(label);
  return (
    <span
      className={cn('grid h-full w-full place-items-center text-[13px] font-bold tracking-[0.03em]', className)}
      style={{ background: cloudSignupAvatarBackground(palette), color: palette.foreground }}
      aria-hidden="true"
    >
      {cloudSignupAvatarInitials(label)}
    </span>
  );
}

export function getIdentityAvatarKey(kind: IdentityAvatarKind, seed: string, avatarKey?: string | null) {
  const value = avatarKey?.trim() || seed.trim() || 'unknown';
  return kind === 'agent' ? `agent:${value.replace(/^agent:/i, '')}` : avatarKey?.trim() || `human:${value}`;
}

export function IdentityAvatar({ kind, seed, isSelf = false, name, imageUrl, avatarKey, className, generatedClassName, presenceStatus, presenceLabel }: IdentityAvatarProps) {
  const activeLocalProfileIdentity = useActiveLocalProfileIdentity();
  const { fallbackLabel, normalizedSeed, resolvedImageUrl: identityImageUrl } = resolveIdentityAvatarPresentation({
    kind,
    seed,
    isSelf,
    name,
    imageUrl,
    activeLocalProfileIdentity,
  });
  const resolvedAvatarKey = getIdentityAvatarKey(kind, normalizedSeed, isSelf ? null : avatarKey);
  const localOverride = useAvatarOverride(resolvedAvatarKey);
  const generatedAgentImageUrl = kind === 'agent' && !identityImageUrl && !localOverride
    ? generatedAvatarPreviewUrl(
        AGENT_CANONICAL_AVATAR_STYLE,
        normalizedSeed,
      )
    : null;
  const originalImageUrl = canonicalAvatarImageUrl(identityImageUrl || localOverride)
    || generatedAgentImageUrl;
  const needsNativeProxy = shouldLoadAvatarThroughNativeProxy(originalImageUrl);
  const remoteAvatar = useRemoteAvatarImage(originalImageUrl, needsNativeProxy);
  const resolvedImageUrl = needsNativeProxy
    ? (remoteAvatar.status === 'ready' ? remoteAvatar.dataUrl : null)
    : originalImageUrl;
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);
  const displayImageUrl = resolvedImageUrl && failedImageUrl !== resolvedImageUrl ? resolvedImageUrl : null;
  const [lastReadyAvatar, setLastReadyAvatar] = useState<{
    identityKey: string;
    imageUrl: string;
  } | null>(null);
  const isRemoteImagePending = needsNativeProxy
    && (remoteAvatar.status === 'idle' || remoteAvatar.status === 'pending');
  const retainedImageUrl = !displayImageUrl
    && needsNativeProxy
    && (isRemoteImagePending || remoteAvatar.status === 'failed')
    && lastReadyAvatar?.identityKey === resolvedAvatarKey
    ? lastReadyAvatar.imageUrl
    : null;
  const visibleImageUrl = displayImageUrl || retainedImageUrl;
  const avatarState = displayImageUrl
    ? 'ready'
    : retainedImageUrl
      ? 'stale'
    : isRemoteImagePending
      ? 'pending'
      : needsNativeProxy && remoteAvatar.status === 'failed'
        ? 'failed'
        : 'fallback';
  const label = name?.trim() ? `${name} avatar` : `${kind === 'agent' ? 'Agent' : 'Human'} avatar`;

  const normalizedPresenceStatus = presenceStatus?.trim().toLowerCase() === 'online' ? 'online' : presenceStatus ? 'offline' : null;
  const resolvedPresenceLabel = presenceLabel?.trim()
    || (normalizedPresenceStatus ? `${name?.trim() || fallbackLabel} is ${normalizedPresenceStatus}` : null);

  return (
    <span className={cn('relative inline-flex shrink-0 rounded-full', className)}>
      <Avatar
        className="h-full w-full rounded-full bg-transparent"
        aria-label={label}
        data-avatar-kind={kind}
        data-avatar-state={avatarState}
      >
        {visibleImageUrl ? null : isRemoteImagePending ? (
          <span
            className="block h-full w-full bg-slate-300/55 dark:bg-slate-700/55"
            aria-hidden="true"
          />
        ) : kind === 'agent' ? (
          <span className={cn('block h-full w-full bg-slate-200 dark:bg-slate-700', generatedClassName)} aria-hidden="true" />
        ) : (
          <HumanInitialsAvatar label={fallbackLabel} className={generatedClassName} />
        )}
        {visibleImageUrl ? (
          <img
            src={visibleImageUrl}
            alt=""
            className="absolute inset-0 block h-full w-full object-cover"
            draggable={false}
            onLoad={() => {
              setLastReadyAvatar((current) => (
                current?.identityKey === resolvedAvatarKey && current.imageUrl === visibleImageUrl
                  ? current
                  : { identityKey: resolvedAvatarKey, imageUrl: visibleImageUrl }
              ));
            }}
            onError={() => {
              setFailedImageUrl(visibleImageUrl);
            }}
          />
        ) : null}
      </Avatar>
      {normalizedPresenceStatus ? (
        <span
          className="app-presence-light"
          data-presence-status={normalizedPresenceStatus}
          aria-label={resolvedPresenceLabel ?? undefined}
          title={resolvedPresenceLabel ?? undefined}
        />
      ) : null}
    </span>
  );
}
