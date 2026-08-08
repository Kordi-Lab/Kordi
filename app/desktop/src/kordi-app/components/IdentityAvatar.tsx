import { useState, useSyncExternalStore } from 'react';

import { Avatar } from '@/components/ui/avatar';
import {
  cloudSignupAvatarBackground,
  cloudSignupAvatarInitials,
  cloudSignupAvatarPalette,
} from '@/features/cloud/signupAvatar';
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

const AGENT_IDENTICON_PALETTES = [
  { background: '#f6f8fa', foreground: '#0969da', accent: '#2da44e' },
  { background: '#f6f8fa', foreground: '#8250df', accent: '#bf3989' },
  { background: '#f6f8fa', foreground: '#1a7f37', accent: '#9a6700' },
  { background: '#f6f8fa', foreground: '#bc4c00', accent: '#0969da' },
  { background: '#0d1117', foreground: '#58a6ff', accent: '#3fb950' },
  { background: '#0d1117', foreground: '#a371f7', accent: '#f778ba' },
  { background: '#0d1117', foreground: '#7ee787', accent: '#d29922' },
  { background: '#0d1117', foreground: '#ffa657', accent: '#79c0ff' },
];
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

export function getLocalAgentAvatarSeed(label?: string | null) {
  if (localAgentAvatarSeedSnapshot?.trim()) return localAgentAvatarSeedSnapshot;

  const identitySeed = readLocalStorageValue(LOCAL_AGENT_IDENTITY_SEED_KEY);
  if (identitySeed) return identitySeed;

  return `local-agent:${browserAvatarScope()}:${label?.trim() || 'kordi'}`;
}

export function setLocalAgentAvatarSeed(seed?: string | null) {
  const normalized = seed?.trim();
  if (!normalized || normalized === localAgentAvatarSeedSnapshot) return;
  localAgentAvatarSeedSnapshot = normalized;
  writeLocalStorageValue(LOCAL_AGENT_IDENTITY_SEED_KEY, normalized);
  emitLocalAvatarSeedsChange();
}

export function useLocalAgentAvatarSeed(label?: string | null) {
  return useSyncExternalStore(
    subscribeLocalAvatarSeeds,
    () => getLocalAgentAvatarSeed(label),
    () => `local-agent:desktop:${label?.trim() || 'kordi'}`,
  );
}

function hashString(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createRandom(seed: string) {
  let state = hashString(seed || 'kordi-avatar');
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, values: T[]) {
  return values[Math.floor(random() * values.length) % values.length];
}

function agentIdenticonParts(seed: string) {
  const random = createRandom(`agent-identicon:${seed}`);
  const palette = pick(random, AGENT_IDENTICON_PALETTES);
  const cells: Array<{ x: number; y: number; accent: boolean; opacity: number }> = [];

  for (let y = 0; y < 5; y += 1) {
    for (let x = 0; x < 3; x += 1) {
      const isActive = random() > 0.42 || (x === 2 && y === 2 && random() > 0.22);
      if (!isActive) continue;

      const accent = random() > 0.78;
      const opacity = 0.82 + random() * 0.18;
      cells.push({ x, y, accent, opacity });
      const mirrorX = 4 - x;
      if (mirrorX !== x) {
        cells.push({ x: mirrorX, y, accent, opacity });
      }
    }
  }

  if (cells.length < 8) {
    cells.push(
      { x: 1, y: 1, accent: false, opacity: 0.92 },
      { x: 3, y: 1, accent: false, opacity: 0.92 },
      { x: 2, y: 2, accent: true, opacity: 0.96 },
      { x: 1, y: 3, accent: false, opacity: 0.92 },
      { x: 3, y: 3, accent: false, opacity: 0.92 },
    );
  }

  return {
    ...palette,
    cells,
  };
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

function AgentIdenticonAvatar({ seed, className }: { seed: string; className?: string }) {
  const parts = agentIdenticonParts(seed);
  const cellSize = 8;
  const gap = 2;
  const origin = 8;

  return (
    <svg className={className} viewBox="0 0 64 64" role="img" aria-hidden="true" shapeRendering="crispEdges">
      <rect width="64" height="64" fill={parts.background} />
      <rect width="64" height="64" fill="#ffffff" opacity={parts.background === '#0d1117' ? '0.04' : '0.22'} />
      {parts.cells.map((cell, index) => (
        <rect
          key={`${cell.x}-${cell.y}-${index}`}
          x={origin + cell.x * (cellSize + gap)}
          y={origin + cell.y * (cellSize + gap)}
          width={cellSize}
          height={cellSize}
          rx="2"
          fill={cell.accent ? parts.accent : parts.foreground}
          opacity={cell.opacity}
        />
      ))}
    </svg>
  );
}

export function getIdentityAvatarKey(kind: IdentityAvatarKind, seed: string, avatarKey?: string | null) {
  return avatarKey?.trim() || `${kind}:${seed.trim() || 'unknown'}`;
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
  const originalImageUrl = localOverride ?? identityImageUrl;
  const needsNativeProxy = shouldLoadAvatarThroughNativeProxy(originalImageUrl);
  const remoteAvatar = useRemoteAvatarImage(originalImageUrl, needsNativeProxy);
  const resolvedImageUrl = needsNativeProxy
    ? (remoteAvatar.status === 'ready' ? remoteAvatar.dataUrl : null)
    : originalImageUrl;
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);
  const displayImageUrl = resolvedImageUrl && failedImageUrl !== resolvedImageUrl ? resolvedImageUrl : null;
  const isRemoteImagePending = needsNativeProxy
    && (remoteAvatar.status === 'idle' || remoteAvatar.status === 'pending');
  const avatarState = displayImageUrl
    ? 'ready'
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
        {displayImageUrl ? null : isRemoteImagePending ? (
          <span
            className="block h-full w-full bg-slate-300/55 dark:bg-slate-700/55"
            aria-hidden="true"
          />
        ) : kind === 'agent' ? (
          <AgentIdenticonAvatar seed={normalizedSeed} className={cn('block h-full w-full', generatedClassName)} />
        ) : (
          <HumanInitialsAvatar label={fallbackLabel} className={generatedClassName} />
        )}
        {displayImageUrl ? (
          <img
            src={displayImageUrl}
            alt=""
            className="absolute inset-0 block h-full w-full object-cover"
            draggable={false}
            onError={() => {
              setFailedImageUrl(displayImageUrl);
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
