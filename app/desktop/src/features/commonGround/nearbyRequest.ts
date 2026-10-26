// The request editor's draft: text, Within, an optional From–Until window in local 15-minute
// slots, and Paused. A new request posts every field; an edit sends only what changed.

import { needWindowError } from './nearbyFormat';
import type { CgNeed, CgNeedInput, CgNeedPatch } from './typesNearby';

/** A local `YYYY-MM-DD` date and `HH:MM` time. */
export type NeedSlot = { date: string; time: string };
export type NeedDraft = { text: string; range: number; window: { from: NeedSlot; until: NeedSlot } | null; paused: boolean };

const pad = (value: number) => String(value).padStart(2, '0');

/** The nearest 15-minute slot, in local time. */
export function slotOf(date: Date): NeedSlot {
  const slot = new Date(date);
  slot.setSeconds(0, 0);
  slot.setMinutes(Math.round(slot.getMinutes() / 15) * 15);
  return { date: `${slot.getFullYear()}-${pad(slot.getMonth() + 1)}-${pad(slot.getDate())}`, time: `${pad(slot.getHours())}:${pad(slot.getMinutes())}` };
}

export const slotTime = (slot: NeedSlot) => new Date(`${slot.date}T${slot.time}`);

/** A window from the next full hour, for three hours. */
export function defaultNeedWindow(now = new Date()): { from: NeedSlot; until: NeedSlot } {
  const from = new Date(now);
  from.setMinutes(0, 0, 0);
  from.setHours(from.getHours() + 1);
  return { from: slotOf(from), until: slotOf(new Date(from.getTime() + 3 * 60 * 60_000)) };
}

/** What the editor opens with: a request's fields, or an empty one within 2 km and no end. */
export function needDraft(need?: CgNeed | null, now = new Date()): NeedDraft {
  if (!need) return { text: '', range: 2000, window: null, paused: false };
  return {
    text: need.text,
    range: need.range,
    paused: need.paused,
    window: need.endsAt ? { from: slotOf(need.startsAt ? new Date(need.startsAt) : now), until: slotOf(new Date(need.endsAt)) } : null,
  };
}

const sameWindow = (left: NeedDraft['window'], right: NeedDraft['window']) => JSON.stringify(left) === JSON.stringify(right);

/** Why the draft cannot be saved, or null. An edit that keeps its window is not checked again. */
export function needDraftError(draft: NeedDraft, initial: NeedDraft | null, now = new Date()): string | null {
  if (!draft.window || (initial && sameWindow(draft.window, initial.window))) return null;
  return needWindowError(slotTime(draft.window.from), slotTime(draft.window.until), now);
}

export function needInput(draft: NeedDraft): CgNeedInput {
  return {
    text: draft.text.trim(),
    range: draft.range,
    startsAt: draft.window ? slotTime(draft.window.from).toISOString() : null,
    endsAt: draft.window ? slotTime(draft.window.until).toISOString() : null,
    paused: draft.paused,
  };
}

/** The changed fields of an edit; turning the window off clears both times. */
export function needPatch(draft: NeedDraft, initial: NeedDraft): CgNeedPatch {
  const input = needInput(draft);
  const patch: CgNeedPatch = {};
  if (input.text !== initial.text.trim()) patch.text = input.text;
  if (draft.range !== initial.range) patch.range = draft.range;
  if (!sameWindow(draft.window, initial.window)) {
    patch.startsAt = input.startsAt;
    patch.endsAt = input.endsAt;
  }
  if (draft.paused !== initial.paused) patch.paused = draft.paused;
  return patch;
}
