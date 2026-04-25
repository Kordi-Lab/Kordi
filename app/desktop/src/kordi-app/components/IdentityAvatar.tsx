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
  ownerSeed?: string | null;
  className?: string;
  generatedClassName?: string;
};

const HUMAN_BACKGROUNDS = ['#f97316', '#14b8a6', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16', '#f59e0b', '#6366f1'];
const HUMAN_ACCENTS = ['#fff7ed', '#ecfeff', '#f5f3ff', '#fdf2f8', '#f0fdf4', '#eff6ff'];
const SKIN_TONES = ['#ffd7a8', '#f1b985', '#c98254', '#8f563b', '#5f3426', '#f6c29f'];
const HAIR_COLORS = ['#20140f', '#3b2418', '#71411f', '#b76e32', '#f4d06f', '#1f2937', '#7c2d12'];
const SHIRT_COLORS = ['#0f766e', '#1d4ed8', '#be123c', '#7c3aed', '#15803d', '#c2410c', '#334155'];

const ROBOT_BACKGROUNDS = ['#242728', '#282622', '#2b292f', '#26302d', '#2f2a25', '#272b32'];
const ROBOT_METALS = ['#d2cbc0', '#c7c2b8', '#bcb8af', '#c9c7c0', '#cec3b5', '#b9c0bd'];
const ROBOT_ACCENTS = ['#9aa58e', '#a58f7b', '#8fa1a8', '#a39a88', '#978fa4', '#8f9b96'];

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

function robotAvatarParts(seed: string, ownerSeed?: string | null) {
  const random = createRandom(`agent:${seed}`);
  const ownerParts = ownerSeed?.trim() ? humanAvatarParts(ownerSeed.trim()) : null;

  return {
    background: ownerParts?.background ?? pick(random, ROBOT_BACKGROUNDS),
    metal: ownerParts?.accent ?? pick(random, ROBOT_METALS),
    accent: ownerParts?.shirt ?? pick(random, ROBOT_ACCENTS),
    dark: random() > 0.48 ? '#343230' : '#2f3434',
    headStyle: Math.floor(random() * 6),
    eyeStyle: Math.floor(random() * 7),
    mouthStyle: Math.floor(random() * 4),
    mouthBars: 2 + Math.floor(random() * 4),
    antenna: Math.floor(random() * 6),
    earStyle: Math.floor(random() * 4),
    bodyStyle: Math.floor(random() * 4),
    facePanel: Math.floor(random() * 4),
    backgroundPattern: Math.floor(random() * 5),
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

function RobotAvatar({ seed, ownerSeed, className }: { seed: string; ownerSeed?: string | null; className?: string }) {
  const parts = robotAvatarParts(seed, ownerSeed);
  const roundedHead = [5, 1, 7, 2, 0, 4][parts.headStyle] ?? 4;
  const headX = [14, 12, 16, 13, 15, 11][parts.headStyle] ?? 14;
  const headY = [16, 18, 15, 14, 17, 16][parts.headStyle] ?? 16;
  const headWidth = [36, 40, 32, 38, 34, 42][parts.headStyle] ?? 36;
  const headHeight = [32, 29, 34, 31, 30, 32][parts.headStyle] ?? 32;
  const faceX = headX + (parts.facePanel === 2 ? 5 : 4);
  const faceY = headY + (parts.facePanel === 1 ? 5 : 4);
  const faceWidth = headWidth - (parts.facePanel === 3 ? 12 : 8);
  const faceHeight = parts.facePanel === 0 ? 26 : parts.facePanel === 1 ? 22 : 24;
  const mouthBars = Array.from({ length: parts.mouthBars }, (_, index) => index);
  const mouthY = faceY + faceHeight - 6;
  const eyeY = faceY + 8;

  return (
    <svg className={className} viewBox="0 0 64 64" role="img" aria-hidden="true" shapeRendering="crispEdges">
      <rect width="64" height="64" fill={parts.background} />
      {parts.backgroundPattern === 0 ? <rect x="6" y="10" width="10" height="3" fill={parts.accent} opacity="0.18" /> : null}
      {parts.backgroundPattern === 0 ? <rect x="9" y="13" width="3" height="8" fill={parts.accent} opacity="0.12" /> : null}
      {parts.backgroundPattern === 1 ? <rect x="48" y="8" width="5" height="18" fill={parts.accent} opacity="0.12" /> : null}
      {parts.backgroundPattern === 1 ? <rect x="42" y="14" width="14" height="3" fill={parts.accent} opacity="0.16" /> : null}
      {parts.backgroundPattern === 2 ? <rect x="7" y="47" width="13" height="4" fill={parts.accent} opacity="0.14" /> : null}
      {parts.backgroundPattern === 2 ? <rect x="12" y="41" width="4" height="13" fill={parts.accent} opacity="0.1" /> : null}
      {parts.backgroundPattern === 3 ? <rect x="49" y="46" width="9" height="3" fill={parts.accent} opacity="0.16" /> : null}
      {parts.backgroundPattern === 3 ? <rect x="52" y="38" width="3" height="8" fill={parts.accent} opacity="0.1" /> : null}
      {parts.backgroundPattern === 4 ? <rect x="5" y="50" width="5" height="5" fill="#fff" opacity="0.05" /> : null}
      {parts.backgroundPattern === 4 ? <rect x="52" y="9" width="4" height="4" fill="#fff" opacity="0.06" /> : null}

      {parts.antenna === 1 ? <rect x="31" y="8" width="2" height="8" fill={parts.accent} opacity="0.64" /> : null}
      {parts.antenna === 1 ? <rect x="28" y="5" width="8" height="5" fill={parts.accent} opacity="0.64" /> : null}
      {parts.antenna === 2 ? <rect x="31" y="7" width="2" height="9" fill={parts.accent} opacity="0.58" /> : null}
      {parts.antenna === 2 ? <rect x="29" y="4" width="6" height="6" fill={parts.accent} opacity="0.58" /> : null}
      {parts.antenna === 3 ? <rect x="22" y="8" width="2" height="9" fill={parts.accent} opacity="0.54" /> : null}
      {parts.antenna === 3 ? <rect x="40" y="8" width="2" height="9" fill={parts.accent} opacity="0.54" /> : null}
      {parts.antenna === 4 ? <rect x="27" y="9" width="10" height="2" fill={parts.accent} opacity="0.58" /> : null}
      {parts.antenna === 4 ? <rect x="30" y="6" width="4" height="4" fill={parts.accent} opacity="0.58" /> : null}
      {parts.antenna === 5 ? <rect x="31" y="6" width="2" height="10" fill={parts.metal} opacity="0.76" /> : null}
      {parts.antenna === 5 ? <rect x="28" y="4" width="8" height="3" fill={parts.accent} opacity="0.5" /> : null}

      <rect x="24" y="48" width="16" height="7" fill={parts.metal} opacity="0.86" />
      <rect x="18" y="53" width="28" height="11" fill={parts.dark} />
      {parts.bodyStyle === 0 ? <rect x="21" y="55" width="22" height="5" fill={parts.accent} opacity="0.28" /> : null}
      {parts.bodyStyle === 1 ? <rect x="24" y="54" width="16" height="7" fill={parts.accent} opacity="0.22" /> : null}
      {parts.bodyStyle === 2 ? <rect x="20" y="56" width="7" height="4" fill={parts.accent} opacity="0.24" /> : null}
      {parts.bodyStyle === 2 ? <rect x="37" y="56" width="7" height="4" fill={parts.accent} opacity="0.24" /> : null}
      {parts.bodyStyle === 3 ? <rect x="29" y="54" width="6" height="9" fill={parts.accent} opacity="0.2" /> : null}

      {parts.earStyle === 0 ? <rect x={headX - 3} y={headY + 12} width="5" height="11" fill={parts.dark} /> : null}
      {parts.earStyle === 0 ? <rect x={headX + headWidth - 2} y={headY + 12} width="5" height="11" fill={parts.dark} /> : null}
      {parts.earStyle === 1 ? <rect x={headX - 4} y={headY + 9} width="4" height="17" fill={parts.metal} opacity="0.82" /> : null}
      {parts.earStyle === 1 ? <rect x={headX + headWidth} y={headY + 9} width="4" height="17" fill={parts.metal} opacity="0.82" /> : null}
      {parts.earStyle === 2 ? <rect x={headX - 5} y={headY + 15} width="6" height="6" fill={parts.accent} opacity="0.36" /> : null}
      {parts.earStyle === 2 ? <rect x={headX + headWidth - 1} y={headY + 15} width="6" height="6" fill={parts.accent} opacity="0.36" /> : null}

      <rect x={headX} y={headY} width={headWidth} height={headHeight} rx={roundedHead} fill={parts.dark} />
      <rect x={faceX} y={faceY} width={faceWidth} height={faceHeight} rx={Math.max(1, roundedHead - 1)} fill={parts.metal} opacity="0.96" />
      {parts.facePanel === 1 ? <rect x={faceX + 3} y={faceY + 3} width={faceWidth - 6} height="3" fill="#fff" opacity="0.12" /> : null}
      {parts.facePanel === 2 ? <rect x={faceX + faceWidth - 5} y={faceY + 4} width="2" height={faceHeight - 8} fill={parts.dark} opacity="0.16" /> : null}
      {parts.facePanel === 3 ? <rect x={faceX + 4} y={faceY + faceHeight - 5} width={faceWidth - 8} height="2" fill={parts.dark} opacity="0.16" /> : null}
      <rect x={faceX + 4} y={faceY + 5} width={faceWidth - 8} height={Math.min(13, faceHeight - 12)} fill={parts.dark} />

      {parts.eyeStyle === 0 ? <rect x={faceX + 7} y={eyeY} width="5" height="5" fill={parts.accent} opacity="0.76" /> : null}
      {parts.eyeStyle === 0 ? <rect x={faceX + faceWidth - 12} y={eyeY} width="5" height="5" fill={parts.accent} opacity="0.76" /> : null}
      {parts.eyeStyle === 1 ? <rect x={faceX + 7} y={eyeY - 1} width={faceWidth - 14} height="5" fill={parts.accent} opacity="0.76" /> : null}
      {parts.eyeStyle === 2 ? <rect x={faceX + 6} y={eyeY - 1} width="7" height="7" fill={parts.accent} opacity="0.76" /> : null}
      {parts.eyeStyle === 2 ? <rect x={faceX + faceWidth - 13} y={eyeY - 1} width="7" height="7" fill={parts.accent} opacity="0.76" /> : null}
      {parts.eyeStyle === 3 ? <rect x={faceX + 6} y={eyeY + 1} width={faceWidth - 12} height="3" fill={parts.accent} opacity="0.76" /> : null}
      {parts.eyeStyle === 4 ? <rect x={faceX + 8} y={eyeY} width="4" height="6" fill={parts.accent} opacity="0.72" /> : null}
      {parts.eyeStyle === 4 ? <rect x={faceX + faceWidth - 10} y={eyeY + 1} width="4" height="5" fill={parts.accent} opacity="0.72" /> : null}
      {parts.eyeStyle === 5 ? <rect x={faceX + 7} y={eyeY} width="12" height="4" fill={parts.accent} opacity="0.68" /> : null}
      {parts.eyeStyle === 5 ? <rect x={faceX + faceWidth - 12} y={eyeY} width="5" height="4" fill={parts.accent} opacity="0.68" /> : null}
      {parts.eyeStyle === 6 ? <rect x={faceX + 8} y={eyeY - 2} width="4" height="4" fill={parts.accent} opacity="0.66" /> : null}
      {parts.eyeStyle === 6 ? <rect x={faceX + faceWidth - 14} y={eyeY + 2} width="10" height="3" fill={parts.accent} opacity="0.66" /> : null}

      {parts.mouthStyle === 0 ? <rect x={faceX + 7} y={mouthY} width={faceWidth - 14} height="2" fill={parts.dark} opacity="0.74" /> : null}
      {parts.mouthStyle === 1 ? <rect x={faceX + 10} y={mouthY - 1} width={faceWidth - 20} height="4" fill={parts.dark} opacity="0.68" /> : null}
      {parts.mouthStyle === 2 ? <rect x={faceX + 9} y={mouthY} width={faceWidth - 18} height="1" fill={parts.dark} opacity="0.78" /> : null}
      {parts.mouthStyle === 3 ? <rect x={faceX + 11} y={mouthY - 2} width={faceWidth - 22} height="5" fill={parts.dark} opacity="0.62" /> : null}
      {mouthBars.map((bar) => (
        <rect key={bar} x={faceX + 8 + bar * 3} y={mouthY} width="1" height="2" fill={parts.accent} opacity="0.5" />
      ))}
      <rect x={faceX + 3} y={faceY + 2} width="3" height="3" fill="#fff" opacity="0.16" />
      <rect x={faceX + faceWidth - 6} y={faceY + faceHeight - 4} width="3" height="3" fill="#000" opacity="0.13" />
    </svg>
  );
}

export function getIdentityAvatarKey(kind: IdentityAvatarKind, seed: string, avatarKey?: string | null) {
  return avatarKey?.trim() || `${kind}:${seed.trim() || 'unknown'}`;
}

export function getLocalAvatarScope() {
  if (typeof window === 'undefined') {
    return 'default';
  }

  return window.location.port || window.location.host || 'default';
}

export function getLocalHumanAvatarKey() {
  return `human:local:${getLocalAvatarScope()}`;
}

export function getLocalAgentAvatarKey() {
  return `agent:local:${getLocalAvatarScope()}:local-agent`;
}

export function IdentityAvatar({ kind, seed, name, imageUrl, avatarKey, ownerSeed, className, generatedClassName }: IdentityAvatarProps) {
  const fallbackSeed = seed.trim() || name?.trim() || `${kind}:unknown`;
  const resolvedAvatarKey = getIdentityAvatarKey(kind, fallbackSeed, avatarKey);
  const normalizedSeed = resolvedAvatarKey;
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
        <RobotAvatar seed={normalizedSeed} ownerSeed={ownerSeed} className={cn('h-full w-full', generatedClassName)} />
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
