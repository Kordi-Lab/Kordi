// Card designs for profiles: one look per fixed kind, and three for custom profiles.
// Workshop and Research group are designs on top of the Custom kind, not server kinds.
// A custom profile keeps the design picked for it on this Mac; otherwise its name decides.

import { kindLabel } from './profiles';
import type { CgProfile, CgProfileInput, CgProfileKind } from './types';

export type CgCardDesign = 'work' | 'health' | 'daily' | 'workshop' | 'research' | 'custom';

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

export type CgDesignMemory = { read: (profileId: string) => CgCardDesign | null; write: (profileId: string, design: CgCardDesign) => void };

const DESIGN_KEY = 'kordi.commonGround.cardDesigns.v1';
const CUSTOM_DESIGNS: CgCardDesign[] = ['workshop', 'research', 'custom'];

function readDesigns(): Record<string, CgCardDesign> {
  try {
    const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(DESIGN_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed as Record<string, CgCardDesign> : {};
  } catch {
    return {};
  }
}

/** Designs picked in New card, by profile id, in localStorage; storage that is off forgets them. */
export const localDesignMemory: CgDesignMemory = {
  read: (profileId) => {
    const design = readDesigns()[profileId];
    return design && CUSTOM_DESIGNS.includes(design) ? design : null;
  },
  write: (profileId, design) => {
    try {
      globalThis.localStorage?.setItem(DESIGN_KEY, JSON.stringify({ ...readDesigns(), [profileId]: design }));
    } catch { /* storage off */ }
  },
};

/** The design a profile draws with: its kind, or for Custom the saved pick, else its name's. */
export function profileDesign(profile: Pick<CgProfile, 'profileId' | 'kind' | 'name'>, memory: CgDesignMemory = localDesignMemory): CgCardDesign {
  if (profile.kind !== 'custom') return profile.kind;
  return memory.read(profile.profileId) ?? designForName(profile.name);
}

/** The New card dialog: the picked design, the name and focus typed into the card, and the fixed kinds already in the wallet. */
export type CgNewCardDraft = { design: CgCardDesign; name: string; focus: string };

/** The first design not in the wallet, so New card opens on something it can create. */
export function firstFreeDesign(taken: CgProfileKind[]): CgCardDesign {
  return CARD_DESIGNS.find((entry) => !taken.includes(entry.kind))?.design ?? 'custom';
}

/** A fresh draft for a design: Workshop and Research group start with their names. */
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

/** The create request for a draft; a fixed kind sends a name only when it differs from the kind's. */
export function newCardInput(draft: CgNewCardDraft): CgProfileInput {
  const { kind } = designEntry(draft.design);
  const name = draft.name.replace(/\s+/g, ' ').trim();
  const focus = draft.focus.trim();
  return {
    kind,
    ...(name && (kind === 'custom' || name !== kindLabel(kind)) ? { name } : {}),
    ...(focus ? { focus } : {}),
  };
}
