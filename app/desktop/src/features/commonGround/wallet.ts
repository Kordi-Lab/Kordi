// The Grounding wallet on the Mac: profiles as cards, the deck rail's layout, and
// which card a room suggests.

import { profileDesign } from './cardDesign';
import type { CgCardFace } from './ProfileCard';
import type { CgState } from './store';
import type { CgProfile, CgProfileKind } from './types';

/** A profile as a card: built, not built yet, or building while it is the current one. */
export function profileFace(profile: CgProfile, state: Pick<CgState, 'profileId' | 'owner'>): CgCardFace {
  const building = profile.profileId === state.profileId && state.owner?.build.status === 'building';
  return {
    design: profileDesign(profile),
    icon: profile.icon,
    kind: profile.kind,
    name: profile.name,
    focus: profile.focus,
    topicCount: profile.topicCount,
    status: building ? 'building' : profile.hasCard ? 'built' : 'empty',
  };
}

/** The Work card an empty wallet suggests. */
export const SUGGESTED_FACE: CgCardFace = { design: 'work', name: 'Work', focus: null, topicCount: 0, status: 'suggested' };

/** The cards in the rail: the profiles, or one suggested Work card for an empty wallet. */
export function deckCards(state: CgState): Array<{ id: string; face: CgCardFace }> {
  if (!state.profiles.length) return [{ id: 'suggested', face: SUGGESTED_FACE }];
  return state.profiles.map((profile) => ({ id: profile.profileId, face: profileFace(profile, state) }));
}

export const DECK = { full: 110, strip: 48, step: 40, ring: 12, plus: 40 } as const;

/**
 * The deck rail: one column of overlapping tiles. Each tile shows a 40px header strip and tucks
 * under the next; the selected tile opens to full height in place and pushes the rest down.
 */
export function deckLayout(ids: string[], selected: string | null) {
  let y = 0;
  const tiles = ids.map((id, index) => {
    const on = id === selected;
    const last = index === ids.length - 1;
    const tile = { id, y, height: on ? DECK.full : last ? DECK.step : DECK.strip, z: index + 1 };
    y += on ? DECK.full + DECK.ring : DECK.step;
    return tile;
  });
  const lastOn = ids.length > 0 && ids[ids.length - 1] === selected;
  const plusY = ids.length ? y + (lastOn ? 0 : DECK.ring) : 0;
  return { tiles, plusY, height: plusY + DECK.plus };
}

/** The built profile a room of this kind suggests, when it is not the one you would share. */
export function suggestedProfile(profiles: CgProfile[], kind: CgProfileKind | null | undefined, currentId: string | null): CgProfile | null {
  if (!kind) return null;
  const current = profiles.find((profile) => profile.profileId === currentId);
  if (current?.kind === kind) return null;
  return profiles.find((profile) => profile.kind === kind && profile.hasCard) ?? null;
}

/** "Workshop · 14 people": the room's kind and size, leaving out what is unknown. */
export function roomPreviewLine(room: { kind: CgProfileKind | null; memberCount: number | null }, kindName: (kind: CgProfileKind) => string): string {
  const people = room.memberCount === null ? '' : room.memberCount === 1 ? '1 person' : `${room.memberCount} people`;
  return [room.kind ? kindName(room.kind) : '', people].filter(Boolean).join(' · ');
}

/** "built 14 Oct" style day for the card page. */
export function shortDay(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return '';
  const day = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  if (Number.isNaN(day.getTime())) return '';
  const text = day.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return day.getFullYear() === now.getFullYear() ? text : `${text} ${day.getFullYear()}`;
}
