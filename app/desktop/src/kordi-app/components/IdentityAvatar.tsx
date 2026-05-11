import { useSyncExternalStore } from 'react';

import { Avatar } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import { useAvatarOverride } from './avatarOverrides';

export type IdentityAvatarKind = 'human' | 'agent';

export type IdentityAvatarProps = {
  kind: IdentityAvatarKind;
  seed: string;
  name?: string | null;
  imageUrl?: string | null;
  avatarKey?: string | null;
  className?: string;
  generatedClassName?: string;
};

const HUMAN_BACKGROUNDS = ['#f97316', '#14b8a6', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16', '#f59e0b', '#6366f1'];
const HUMAN_ACCENTS = ['#fff7ed', '#ecfeff', '#f5f3ff', '#fdf2f8', '#f0fdf4', '#eff6ff'];
const SKIN_TONES = ['#ffd7a8', '#f1b985', '#c98254', '#8f563b', '#5f3426', '#f6c29f'];
const HAIR_COLORS = ['#20140f', '#3b2418', '#71411f', '#b76e32', '#f4d06f', '#1f2937', '#7c2d12'];
const SHIRT_COLORS = ['#0f766e', '#1d4ed8', '#be123c', '#7c3aed', '#15803d', '#c2410c', '#334155'];

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
  window.dispatchEvent(new Event(LOCAL_AVATAR_SEEDS_CHANGE_EVENT));
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

function humanAvatarParts(seed: string) {
  const random = createRandom(`human:${seed}`);
  return {
    background: pick(random, HUMAN_BACKGROUNDS),
    accent: pick(random, HUMAN_ACCENTS),
    skin: pick(random, SKIN_TONES),
    hair: pick(random, HAIR_COLORS),
    shirt: pick(random, SHIRT_COLORS),
    hairStyle: Math.floor(random() * 5),
    mouthStyle: Math.floor(random() * 3),
    accessory: Math.floor(random() * 4),
    cheek: random() > 0.52,
  };
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

function PixelHumanAvatar({ seed, className }: { seed: string; className?: string }) {
  const parts = humanAvatarParts(seed);
  const hairCap = parts.hairStyle === 0;
  const sidePart = parts.hairStyle === 1;
  const bangs = parts.hairStyle === 2;
  const cropped = parts.hairStyle === 3;

  return (
    <svg className={className} viewBox="0 0 64 64" role="img" aria-hidden="true" shapeRendering="crispEdges">
      <rect width="64" height="64" fill={parts.background} />
      <rect x="4" y="6" width="10" height="10" fill={parts.accent} opacity="0.28" />
      <rect x="50" y="9" width="6" height="6" fill={parts.accent} opacity="0.34" />
      <rect x="7" y="48" width="7" height="7" fill="#020617" opacity="0.14" />
      <rect x="48" y="46" width="10" height="10" fill="#020617" opacity="0.12" />

      <rect x="18" y="48" width="28" height="7" fill={parts.skin} />
      <rect x="13" y="53" width="38" height="11" fill={parts.shirt} />
      <rect x="27" y="53" width="4" height="5" fill={parts.accent} opacity="0.78" />
      <rect x="33" y="53" width="4" height="5" fill={parts.accent} opacity="0.78" />

      <rect x="14" y="27" width="5" height="11" fill={parts.skin} />
      <rect x="45" y="27" width="5" height="11" fill={parts.skin} />
      <rect x="18" y="18" width="28" height="29" fill={parts.skin} />
      <rect x="19" y="43" width="26" height="4" fill="#000" opacity="0.08" />

      {hairCap ? <rect x="17" y="15" width="30" height="10" fill={parts.hair} /> : null}
      {hairCap ? <rect x="16" y="22" width="7" height="12" fill={parts.hair} /> : null}
      {hairCap ? <rect x="41" y="22" width="7" height="9" fill={parts.hair} /> : null}

      {sidePart ? <rect x="16" y="16" width="31" height="7" fill={parts.hair} /> : null}
      {sidePart ? <rect x="16" y="23" width="13" height="6" fill={parts.hair} /> : null}
      {sidePart ? <rect x="16" y="29" width="6" height="11" fill={parts.hair} /> : null}

      {bangs ? <rect x="18" y="15" width="28" height="8" fill={parts.hair} /> : null}
      {bangs ? <rect x="20" y="23" width="6" height="6" fill={parts.hair} /> : null}
      {bangs ? <rect x="29" y="23" width="6" height="5" fill={parts.hair} /> : null}
      {bangs ? <rect x="38" y="23" width="6" height="6" fill={parts.hair} /> : null}

      {cropped ? <rect x="20" y="15" width="24" height="6" fill={parts.hair} /> : null}
      {cropped ? <rect x="17" y="20" width="30" height="5" fill={parts.hair} /> : null}

      {!hairCap && !sidePart && !bangs && !cropped ? <rect x="18" y="16" width="28" height="5" fill={parts.hair} /> : null}
      {!hairCap && !sidePart && !bangs && !cropped ? <rect x="15" y="21" width="7" height="10" fill={parts.hair} /> : null}
      {!hairCap && !sidePart && !bangs && !cropped ? <rect x="42" y="21" width="7" height="10" fill={parts.hair} /> : null}

      {parts.accessory === 1 ? <rect x="23" y="29" width="18" height="3" fill="#111827" opacity="0.86" /> : null}
      {parts.accessory === 1 ? <rect x="22" y="31" width="7" height="6" fill="none" stroke="#111827" strokeWidth="2" /> : null}
      {parts.accessory === 1 ? <rect x="35" y="31" width="7" height="6" fill="none" stroke="#111827" strokeWidth="2" /> : null}

      <rect x="24" y="31" width="4" height="5" fill="#111827" />
      <rect x="36" y="31" width="4" height="5" fill="#111827" />
      <rect x="29" y="36" width="6" height="2" fill="#000" opacity="0.12" />
      {parts.cheek ? <rect x="21" y="38" width="4" height="3" fill="#fb7185" opacity="0.38" /> : null}
      {parts.cheek ? <rect x="39" y="38" width="4" height="3" fill="#fb7185" opacity="0.38" /> : null}
      {parts.mouthStyle === 0 ? <rect x="28" y="42" width="8" height="2" fill="#7f1d1d" opacity="0.72" /> : null}
      {parts.mouthStyle === 1 ? <rect x="27" y="41" width="10" height="2" fill="#7f1d1d" opacity="0.68" /> : null}
      {parts.mouthStyle === 1 ? <rect x="29" y="43" width="6" height="2" fill="#7f1d1d" opacity="0.68" /> : null}
      {parts.mouthStyle === 2 ? <rect x="29" y="42" width="6" height="2" fill="#111827" opacity="0.52" /> : null}
    </svg>
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
      <circle cx="32" cy="32" r="31.5" fill="none" stroke="#ffffff" strokeOpacity="0.18" />
      <circle cx="32" cy="32" r="31.5" fill="none" stroke="#0d1117" strokeOpacity="0.16" />
    </svg>
  );
}

export function getIdentityAvatarKey(kind: IdentityAvatarKind, seed: string, avatarKey?: string | null) {
  return avatarKey?.trim() || `${kind}:${seed.trim() || 'unknown'}`;
}

export function IdentityAvatar({ kind, seed, name, imageUrl, avatarKey, className, generatedClassName }: IdentityAvatarProps) {
  const normalizedSeed = seed.trim() || name?.trim() || `${kind}:unknown`;
  const resolvedAvatarKey = getIdentityAvatarKey(kind, normalizedSeed, avatarKey);
  const localOverride = useAvatarOverride(resolvedAvatarKey);
  const resolvedImageUrl = localOverride ?? imageUrl;
  const label = name?.trim() ? `${name} avatar` : `${kind === 'agent' ? 'Agent' : 'Human'} avatar`;

  return (
    <Avatar
      className={cn(
        'rounded-full bg-slate-900/30 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]',
        className,
      )}
      aria-label={label}
      data-avatar-kind={kind}
    >
      {kind === 'agent' ? (
        <AgentIdenticonAvatar seed={normalizedSeed} className={cn('block h-full w-full', generatedClassName)} />
      ) : (
        <PixelHumanAvatar seed={normalizedSeed} className={cn('block h-full w-full', generatedClassName)} />
      )}
      {resolvedImageUrl ? (
        <img
          src={resolvedImageUrl}
          alt=""
          className="absolute inset-0 block h-full w-full object-cover"
          draggable={false}
          onError={(event) => {
            event.currentTarget.style.display = 'none';
          }}
        />
      ) : null}
    </Avatar>
  );
}
