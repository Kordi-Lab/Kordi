// Card looks for profiles: six backgrounds and an optional icon, kept by the server.
// Workshop and Research group are designs on top of the Custom kind, not server kinds.
// A profile without a design draws its kind's; a custom one without a design goes by its name.

import { kindLabel } from './profiles';
import {
  CG_CARD_DESIGNS, CG_CARD_ICONS, CG_COLOUR_DESIGNS, type CgCardDesign, type CgCardIcon, type CgProfileInput, type CgProfileKind, type CgProfileTag,
} from './types';

export type { CgCardDesign, CgCardIcon } from './types';

export type CgColourDesign = (typeof CG_COLOUR_DESIGNS)[number];

/** The ten plain colour backgrounds, in the popover's order; each keeps its kind's glyph. */
export const COLOUR_DESIGNS: Array<{ design: CgColourDesign; label: string }> = CG_COLOUR_DESIGNS.map((design) => (
  { design, label: `${design[0].toUpperCase()}${design.slice(1)}` }
));

export function isColourDesign(design: CgCardDesign): design is CgColourDesign {
  return (CG_COLOUR_DESIGNS as readonly string[]).includes(design);
}

/** New card's swatches, in order: the design, its kind, its label and the name it starts with. */
export const CARD_DESIGNS: Array<{ design: CgCardDesign; kind: CgProfileKind; label: string; name: string }> = [
  { design: 'work', kind: 'work', label: 'Work', name: '' },
  { design: 'health', kind: 'health', label: 'Health', name: '' },
  { design: 'daily', kind: 'daily', label: 'Daily tasks', name: '' },
  { design: 'workshop', kind: 'custom', label: 'Workshop', name: 'Workshop' },
  { design: 'research', kind: 'custom', label: 'Research group', name: 'Research group' },
  { design: 'custom', kind: 'custom', label: 'Custom', name: '' },
];

export function designEntry(design: CgCardDesign) {
  return CARD_DESIGNS.find((entry) => entry.design === design) ?? CARD_DESIGNS[CARD_DESIGNS.length - 1];
}

const WORKSHOP_NAME = /\b(workshop|conference|summit|meetup|poster|hackathon)s?\b/i;
const RESEARCH_NAME = /\b(research|group|lab|university|institute|college|school|faculty)\b/i;
const ACRONYM = /^[A-Z]{2,6}$/;

/** The design a custom profile's name suggests: workshops and events, research groups (KAUST, MIT), else Custom. */
export function designForName(name: string): CgCardDesign {
  const trimmed = name.trim();
  if (WORKSHOP_NAME.test(trimmed)) return 'workshop';
  if (RESEARCH_NAME.test(trimmed) || ACRONYM.test(trimmed)) return 'research';
  return 'custom';
}

const LEGACY_DESIGN_KEY = 'kordi.commonGround.cardDesigns.v1';

/** Designs older builds kept per profile on this Mac, read once to move them to the server. */
export type CgLegacyDesigns = { read: () => Record<string, CgCardDesign>; clear: () => void };

export const localLegacyDesigns: CgLegacyDesigns = {
  read: () => {
    try {
      const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(LEGACY_DESIGN_KEY) ?? '{}');
      if (!parsed || typeof parsed !== 'object') return {};
      return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, CgCardDesign] => isCardDesign(entry[1])));
    } catch {
      return {};
    }
  },
  clear: () => {
    try { globalThis.localStorage?.removeItem(LEGACY_DESIGN_KEY); } catch { /* storage off */ }
  },
};

export function isCardDesign(value: unknown): value is CgCardDesign {
  return typeof value === 'string' && (CG_CARD_DESIGNS as readonly string[]).includes(value);
}

export function isCardIcon(value: unknown): value is CgCardIcon {
  return typeof value === 'string' && (CG_CARD_ICONS as readonly string[]).includes(value);
}

/** The design a profile draws with: the server's, else its kind's, and for Custom its name's. */
export function profileDesign(profile: Pick<CgProfileTag, 'kind' | 'name' | 'design'>): CgCardDesign {
  if (profile.design) return profile.design;
  if (profile.kind !== 'custom') return profile.kind;
  return designForName(profile.name);
}

/**
 * The New card dialog: the picked design (which sets the kind), the name and focus typed into
 * the card, and the background and icon picked on the card's icon square.
 */
export type CgNewCardDraft = { design: CgCardDesign; name: string; focus: string; background?: CgCardDesign | null; icon?: CgCardIcon | null };

/** The background a draft draws with. */
export function draftDesign(draft: CgNewCardDraft): CgCardDesign {
  return draft.background ?? draft.design;
}

/** The first design not in the wallet, so New card opens on something it can create. */
export function firstFreeDesign(taken: CgProfileKind[]): CgCardDesign {
  return CARD_DESIGNS.find((entry) => !taken.includes(entry.kind))?.design ?? 'custom';
}

/** A fresh draft for a design: Workshop and Research group start with their names; the look starts over. */
export function newCardDraft(design: CgCardDesign, previous?: CgNewCardDraft): CgNewCardDraft {
  const entry = designEntry(design);
  const keepName = previous && previous.name.trim() && !CARD_DESIGNS.some((item) => item.name && item.name === previous.name);
  return { design, name: keepName ? previous.name : entry.name, focus: previous?.focus ?? '' };
}

/** True when the draft's kind is not taken and a custom card has a name. */
export function canCreateCard(draft: CgNewCardDraft, taken: CgProfileKind[]): boolean {
  const { kind } = designEntry(draft.design);
  if (taken.includes(kind)) return false;
  return kind !== 'custom' || Boolean(draft.name.trim());
}

/**
 * The create request for a draft; a fixed kind sends a name only when it differs from the kind's,
 * and a design only when it is not the kind's own. Custom always sends its design.
 */
export function newCardInput(draft: CgNewCardDraft): CgProfileInput {
  const { kind } = designEntry(draft.design);
  const name = draft.name.replace(/\s+/g, ' ').trim();
  const focus = draft.focus.trim();
  const design = draftDesign(draft);
  return {
    kind,
    ...(name && (kind === 'custom' || name !== kindLabel(kind)) ? { name } : {}),
    ...(focus ? { focus } : {}),
    ...(kind === 'custom' || design !== kind ? { design } : {}),
    ...(draft.icon ? { icon: draft.icon } : {}),
  };
}
