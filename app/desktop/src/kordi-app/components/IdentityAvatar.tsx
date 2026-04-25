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

const ROBOT_BACKGROUNDS = ['#0f172a', '#1e1b4b', '#164e63', '#312e81', '#3b0764', '#064e3b', '#431407', '#111827'];
const ROBOT_METALS = ['#cbd5e1', '#94a3b8', '#a5b4fc', '#bae6fd', '#d8b4fe', '#99f6e4'];
const ROBOT_ACCENTS = ['#22d3ee', '#a78bfa', '#34d399', '#fbbf24', '#fb7185', '#60a5fa'];
const LOCAL_PROFILE_AVATAR_SEED_KEY = 'kordi.localProfileAvatarSeed.v1';
const LOCAL_PROFILE_IDENTITY_SEED_KEY = 'kordi.localProfileIdentitySeed.v1';

export function getLocalProfileAvatarSeed() {
  if (typeof window === 'undefined') return 'local-human-profile';
  const instanceScope = window.location.origin || 'desktop';
  try {
    const identitySeed = window.localStorage.getItem(LOCAL_PROFILE_IDENTITY_SEED_KEY)?.trim();
    if (identitySeed) return identitySeed;

    const existing = window.localStorage.getItem(LOCAL_PROFILE_AVATAR_SEED_KEY)?.trim();
    if (existing) return `local-human-profile:${instanceScope}:${existing}`;
    const next = window.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    window.localStorage.setItem(LOCAL_PROFILE_AVATAR_SEED_KEY, next);
    return `local-human-profile:${instanceScope}:${next}`;
  } catch {
    return `local-human-profile:${instanceScope}`;
  }
}

export function setLocalProfileAvatarSeed(seed?: string | null) {
  if (typeof window === 'undefined') return;
  const normalizedSeed = seed?.trim();
  if (!normalizedSeed) return;
  try {
    window.localStorage.setItem(LOCAL_PROFILE_IDENTITY_SEED_KEY, normalizedSeed);
  } catch {
    // Ignore storage failures; getLocalProfileAvatarSeed will fall back to the instance seed.
  }
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

function robotAvatarParts(seed: string) {
  const random = createRandom(`agent:${seed}`);
  return {
    background: pick(random, ROBOT_BACKGROUNDS),
    metal: pick(random, ROBOT_METALS),
    accent: pick(random, ROBOT_ACCENTS),
    dark: random() > 0.48 ? '#0f172a' : '#111827',
    headStyle: Math.floor(random() * 4),
    eyeStyle: Math.floor(random() * 4),
    mouthBars: 2 + Math.floor(random() * 4),
    antenna: Math.floor(random() * 3),
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

function RobotAvatar({ seed, className }: { seed: string; className?: string }) {
  const parts = robotAvatarParts(seed);
  const roundedHead = parts.headStyle % 2 === 0 ? 5 : 1;
  const hasAntennaStem = parts.antenna !== 0;
  const mouthBars = Array.from({ length: parts.mouthBars }, (_, index) => index);

  return (
    <svg className={className} viewBox="0 0 64 64" role="img" aria-hidden="true" shapeRendering="crispEdges">
      <rect width="64" height="64" fill={parts.background} />
      <rect x="6" y="10" width="10" height="3" fill={parts.accent} opacity="0.45" />
      <rect x="9" y="13" width="3" height="8" fill={parts.accent} opacity="0.3" />
      <rect x="49" y="46" width="9" height="3" fill={parts.accent} opacity="0.35" />
      <rect x="52" y="38" width="3" height="8" fill={parts.accent} opacity="0.22" />
      <rect x="5" y="50" width="5" height="5" fill="#fff" opacity="0.08" />

      {hasAntennaStem ? <rect x="31" y="8" width="2" height="8" fill={parts.accent} /> : null}
      {parts.antenna === 1 ? <rect x="28" y="5" width="8" height="5" fill={parts.accent} /> : null}
      {parts.antenna === 2 ? <rect x="29" y="4" width="6" height="6" fill={parts.accent} /> : null}

      <rect x="24" y="48" width="16" height="7" fill={parts.metal} opacity="0.9" />
      <rect x="18" y="53" width="28" height="11" fill={parts.dark} />
      <rect x="21" y="55" width="22" height="5" fill={parts.accent} opacity="0.72" />
      <rect x="11" y="28" width="6" height="12" fill={parts.dark} />
      <rect x="47" y="28" width="6" height="12" fill={parts.dark} />
      <rect x="14" y="16" width="36" height="32" rx={roundedHead} fill={parts.dark} />
      <rect x="17" y="19" width="30" height="26" rx={roundedHead} fill={parts.metal} />
      <rect x="21" y="24" width="22" height="13" fill={parts.dark} />

      {parts.eyeStyle === 0 ? <rect x="24" y="28" width="5" height="5" fill={parts.accent} /> : null}
      {parts.eyeStyle === 0 ? <rect x="35" y="28" width="5" height="5" fill={parts.accent} /> : null}
      {parts.eyeStyle === 1 ? <rect x="24" y="27" width="16" height="5" fill={parts.accent} /> : null}
      {parts.eyeStyle === 2 ? <rect x="23" y="27" width="7" height="7" fill={parts.accent} /> : null}
      {parts.eyeStyle === 2 ? <rect x="35" y="27" width="7" height="7" fill={parts.accent} /> : null}
      {parts.eyeStyle === 2 ? <rect x="25" y="29" width="3" height="3" fill="#fff" opacity="0.6" /> : null}
      {parts.eyeStyle === 2 ? <rect x="37" y="29" width="3" height="3" fill="#fff" opacity="0.6" /> : null}
      {parts.eyeStyle === 3 ? <rect x="23" y="29" width="18" height="3" fill={parts.accent} /> : null}
      {parts.eyeStyle === 3 ? <rect x="26" y="26" width="3" height="3" fill={parts.accent} opacity="0.7" /> : null}
      {parts.eyeStyle === 3 ? <rect x="36" y="26" width="3" height="3" fill={parts.accent} opacity="0.7" /> : null}

      <rect x="24" y="40" width="16" height="2" fill={parts.dark} opacity="0.78" />
      {mouthBars.map((bar) => (
        <rect key={bar} x={25 + bar * 3} y="40" width="1" height="2" fill={parts.accent} opacity="0.9" />
      ))}
      <rect x="20" y="21" width="3" height="3" fill="#fff" opacity="0.35" />
      <rect x="41" y="42" width="3" height="3" fill="#000" opacity="0.16" />
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
      className={cn('bg-slate-900/30 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]', className)}
      aria-label={label}
      data-avatar-kind={kind}
    >
      {kind === 'agent' ? (
        <RobotAvatar seed={normalizedSeed} className={cn('h-full w-full', generatedClassName)} />
      ) : (
        <PixelHumanAvatar seed={normalizedSeed} className={cn('h-full w-full', generatedClassName)} />
      )}
      {resolvedImageUrl ? (
        <img
          src={resolvedImageUrl}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          draggable={false}
          onError={(event) => {
            event.currentTarget.style.display = 'none';
          }}
        />
      ) : null}
    </Avatar>
  );
}
