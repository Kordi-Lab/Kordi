// Labels and rules for Grounding › Nearby: distance bands, filters, the location line, pauses and
// request time windows. Times are local and read in English, like the rest of Grounding.

import { peopleCount } from './format';
import { shareableProfiles } from './profiles';
import { CG_TOPIC_SECTIONS, type CgProfile, type CgTopicLists } from './types';
import type { CgNearbyCheck, CgNearbyDistance, CgNearbyLocation, CgNearbySettings, CgNeed } from './typesNearby';

/** Distance bands by `maxMeters`, as the server returns them. */
export const NEARBY_BANDS: Array<[number, string]> = [
  [500, 'Under 500 m'], [1000, 'Under 1 km'], [2000, '1–2 km'], [5000, '2–5 km'], [10000, '5–10 km'], [25000, '10–25 km'],
];
/** The Within choices: one per band. */
export const NEARBY_RANGES: Array<[number, string]> = [[500, '500 m'], [1000, '1 km'], [2000, '2 km'], [5000, '5 km'], [10000, '10 km'], [25000, '25 km']];
export const NEARBY_SCORES: Array<[number, string]> = [[0, 'Any'], [50, '50%+'], [70, '70%+'], [85, '85%+']];
export const NEARBY_PER_DAY: Array<[number, string]> = [[1, '1 a day'], [3, '3 a day'], [10, '10 a day']];
export const OPEN_TO_SUGGESTIONS = ['Coffee chat', 'Collaborating', 'Advice', 'Hiring'];
export const OPEN_TO_MAX = 5;
export const OPEN_TO_CHARS = 30;
export const NEED_TEXT_MAX = 200;
/** How far ahead a pause or a request's end may be. */
export const NEARBY_MAX_AHEAD_MS = 7 * 24 * 60 * 60_000;

export function bandLabel(distance: Pick<CgNearbyDistance, 'maxMeters'>): string {
  return (NEARBY_BANDS.find(([max]) => distance.maxMeters <= max) ?? NEARBY_BANDS[NEARBY_BANDS.length - 1])[1];
}

export function rangeLabel(range: number): string {
  return (NEARBY_RANGES.find(([value]) => value === range) ?? NEARBY_RANGES[2])[1];
}

export const rangePill = (range: number) => `Within ${rangeLabel(range)}`;
export const scorePill = (score: number) => (score > 0 ? `${score}%+ match` : 'Any match');
export const perDayLabel = (count: number) => (NEARBY_PER_DAY.find(([value]) => value === count) ?? NEARBY_PER_DAY[1])[1];

/** True when the location counts as current. */
export function locationFresh(location: CgNearbyLocation | null | undefined, now = Date.now()): boolean {
  if (!location?.fresh) return false;
  const until = Date.parse(location.freshUntil);
  return Number.isNaN(until) || until > now;
}

/** "Location updated · 3 min ago". */
export function locationLine(location: CgNearbyLocation, now = Date.now()): string {
  const minutes = Math.max(1, Math.floor((now - Date.parse(location.capturedAt)) / 60_000) || 1);
  return `Location updated · ${minutes} min ago`;
}

export const NO_PHONE_LINE = 'Update your location to find people nearby.';

/** Off, paused, on without a current location from the iPhone, or on. */
export type CgNearbyPhase = 'off' | 'paused' | 'no-phone' | 'on';

export function pausedNow(settings: Pick<CgNearbySettings, 'pausedUntil'>, now = Date.now()): boolean {
  const until = settings.pausedUntil ? Date.parse(settings.pausedUntil) : NaN;
  return !Number.isNaN(until) && until > now;
}

/**
 * Enabled but not taking part (the shared card lost its topics or sharing) reads as off. `blocked` is what search last
 * answered: `off` when the viewer does not take part, `no_location` without a current location.
 */
export function nearbyPhase(settings: CgNearbySettings | null, blocked: 'off' | 'no_location' | null, now = Date.now()): CgNearbyPhase {
  if (!settings?.enabled) return 'off';
  if (pausedNow(settings, now)) return 'paused';
  if (blocked === 'off' || !settings.participating) return 'off';
  if (blocked === 'no_location' || !locationFresh(settings.location, now)) return 'no-phone';
  return 'on';
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

function dayWord(date: Date, now: Date): string {
  if (dayKey(date) === dayKey(now)) return 'today';
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (dayKey(date) === dayKey(tomorrow)) return 'tomorrow';
  return WEEKDAYS[date.getDay()];
}

/** "3:00 PM". */
export function clockTime(date: Date): string {
  const hours = date.getHours();
  return `${hours % 12 || 12}:${String(date.getMinutes()).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
}

/** "3 PM", or "3:30 PM". */
const shortTime = (date: Date) => clockTime(date).replace(':00', '');

/** "3:00 PM" for a pause ending within 12 hours, else "tomorrow" or a weekday. */
export function pauseLabel(until: string, now = new Date()): string {
  const end = new Date(until);
  if (end.getTime() - now.getTime() < 12 * 60 * 60_000) return clockTime(end);
  return dayWord(end, now);
}

/** "Paused until 3:00 PM". */
export const pausedLine = (until: string, now = new Date()) => `Paused until ${pauseLabel(until, now)}`;

/** Pause for 1 hour; pause until tomorrow at 8 AM. */
export function pauseUntil(choice: 'hour' | 'tomorrow', now = new Date()): string {
  if (choice === 'hour') return new Date(now.getTime() + 60 * 60_000).toISOString();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 8, 0, 0, 0).toISOString();
}

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

/** "3–6 PM today", "Until 6 PM tomorrow", or "Today 10 PM – tomorrow 2 AM". */
export function windowLabel(startsAt: string | null, endsAt: string, now = new Date()): string {
  const end = new Date(endsAt);
  if (!startsAt) return `Until ${shortTime(end)} ${dayWord(end, now)}`;
  const start = new Date(startsAt);
  if (dayKey(start) !== dayKey(end)) return capitalize(`${dayWord(start, now)} ${shortTime(start)} – ${dayWord(end, now)} ${shortTime(end)}`);
  const [from, until] = [shortTime(start), shortTime(end)];
  const sameHalf = from.slice(-2) === until.slice(-2);
  return `${sameHalf ? from.slice(0, -3) : from}–${until} ${dayWord(end, now)}`;
}

export function needEnded(need: Pick<CgNeed, 'status' | 'endsAt'>, now = Date.now()): boolean {
  return need.status === 'ended' || (need.endsAt !== null && Date.parse(need.endsAt) <= now);
}

/** "No end · 2 km", "3–6 PM today · 1 km", "Paused" or "Ended". */
export function needSub(need: CgNeed, now = new Date()): string {
  if (need.paused || need.status === 'paused') return 'Paused';
  if (needEnded(need, now.getTime())) return 'Ended';
  return `${need.endsAt ? windowLabel(need.startsAt, need.endsAt, now) : 'No end'} · ${rangeLabel(need.range)}`;
}

/** Why a time window cannot be saved, in the server's words, or null. */
export function needWindowError(startsAt: Date | null, endsAt: Date | null, now = new Date()): string | null {
  if (!endsAt) return null;
  if (Number.isNaN(endsAt.getTime()) || endsAt.getTime() <= now.getTime() || endsAt.getTime() > now.getTime() + NEARBY_MAX_AHEAD_MS) {
    return 'End the request within the next 7 days.';
  }
  if (startsAt && (Number.isNaN(startsAt.getTime()) || startsAt.getTime() >= endsAt.getTime())) return 'Start the request before it ends.';
  return null;
}

/** The Nearby row's line on Home. `people` is null until the first results arrive. */
export function nearbyRowSub(phase: CgNearbyPhase, settings: CgNearbySettings | null, people: number | null, now = new Date()): string | null {
  if (phase === 'off') return settings ? 'Off' : null;
  if (phase === 'paused' && settings?.pausedUntil) return pausedLine(settings.pausedUntil, now);
  if (phase === 'no-phone') return 'Location needed';
  return people === null ? 'Using your latest device location' : `${peopleCount(people)} nearby`;
}

/** The trimmed entry to add to Open to, or null when it is empty, a duplicate or over the limit. */
export function openToEntry(list: string[], raw: string): string | null {
  const value = raw.replace(/\s+/g, ' ').trim().slice(0, OPEN_TO_CHARS);
  if (!value || list.length >= OPEN_TO_MAX || list.some((item) => item.toLowerCase() === value.toLowerCase())) return null;
  return value;
}

/** The cards Nearby can share: built and shared, else any built card (the server then says why not). */
export function nearbyCards(profiles: CgProfile[]): CgProfile[] {
  const built = shareableProfiles(profiles);
  return built.some((profile) => profile.sharing) ? built.filter((profile) => profile.sharing) : built;
}

export type NbMenuItem = { key: string; label: string; checked?: boolean; danger?: boolean; separated?: boolean; onSelect: () => void };

/** Menu choices with a tick on the current one, from `[value, label]` pairs. */
export function checkItems<T extends string | number>(choices: Array<[T, string]>, current: T, onPick: (value: T) => void): NbMenuItem[] {
  return choices.map(([value, label]) => ({ key: String(value), label, checked: value === current, onSelect: () => onPick(value) }));
}

const fold = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();

/** "Working on · Founding Loom Labs": where a met condition's evidence sits; "Not shared" when nothing shows it. */
export function evidenceLine(check: CgNearbyCheck, card: CgTopicLists): string {
  const evidence = check.evidence;
  if (!evidence) return 'Not shared';
  if (check.verdict !== 'met') return evidence;
  const section = CG_TOPIC_SECTIONS.find(([key]) => card[key].some((topic) => fold(topic) === fold(evidence)))?.[1];
  const where = check.kind === 'willingness' ? 'Meet for' : check.kind === 'work' ? 'Working on' : section ?? (check.kind === 'affiliation' ? 'Profile' : null);
  return where ? `${where} · ${evidence}` : evidence;
}
