// Typed calls for `/v1/cloud/common-ground/nearby…`, folded into the Grounding client. Replies are
// normalised so missing fields read as their defaults. Any signed-in device can post a location.

import type { NearbyLocationInput } from './nearbyLocationFix';
import type { CgMatchStatus, CgPerson, CgRelationship, CgTopicLists } from './types';
import type {
  CgNearbyAlerts, CgNearbyCheck, CgNearbyCheckKind, CgNearbyEntry, CgNearbyLocation, CgNearbyPatch, CgNearbyPerson, CgNearbyRequestCheck,
  CgNearbyResults, CgNearbySettings, CgNearbyVerdict, CgNeed, CgNeedInput, CgNeedPatch, CgNeedStatus,
} from './typesNearby';

type Data = <T>(method: string, path: string, body?: unknown) => Promise<T>;
type Raw = Record<string, unknown>;

const enc = encodeURIComponent;
const nb = (path = '') => `common-ground/nearby${path}`;
const record = (value: unknown): Raw => (value && typeof value === 'object' && !Array.isArray(value) ? value as Raw : {});
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const textOrNull = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const num = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(value as T) ? value as T : fallback);

const DEFAULT_ALERTS: CgNearbyAlerts = { requests: true, matches: true, matchMinScore: 85, maxPerDay: 3 };

function locationOf(value: unknown): CgNearbyLocation | null {
  const raw = record(value);
  const capturedAt = text(raw.capturedAt);
  return capturedAt ? { capturedAt, freshUntil: text(raw.freshUntil), fresh: raw.fresh === true } : null;
}

export function nearbySettingsOf(value: unknown): CgNearbySettings {
  const raw = record(value);
  const alerts = record(raw.alerts);
  return {
    enabled: raw.enabled === true,
    participating: raw.participating === true,
    pausedUntil: textOrNull(raw.pausedUntil),
    consentedAt: textOrNull(raw.consentedAt),
    profileId: textOrNull(raw.profileId),
    openTo: strings(raw.openTo),
    range: num(raw.range, 2000),
    minScore: num(raw.minScore, 0),
    alerts: {
      requests: typeof alerts.requests === 'boolean' ? alerts.requests : DEFAULT_ALERTS.requests,
      matches: typeof alerts.matches === 'boolean' ? alerts.matches : DEFAULT_ALERTS.matches,
      matchMinScore: num(alerts.matchMinScore, DEFAULT_ALERTS.matchMinScore),
      maxPerDay: num(alerts.maxPerDay, DEFAULT_ALERTS.maxPerDay),
    },
    location: locationOf(raw.location),
    freshSeconds: num(raw.freshSeconds, 1800),
  };
}

/** The person with the entry's `relationship` folded in, as the other Grounding replies do. */
function personOf(raw: Raw): CgPerson {
  const person = record(raw.person) as unknown as CgPerson;
  const relationship = (raw.relationship ?? person.relationship) as CgRelationship | undefined;
  return relationship ? { ...person, relationship } : person;
}

const STATUSES: readonly CgMatchStatus[] = ['ready', 'matching', 'failed'];

function entryBase(raw: Raw): Omit<CgNearbyEntry, 'requests'> {
  const distance = record(raw.distance);
  return {
    person: personOf(raw),
    distance: { minMeters: num(distance.minMeters, 0), maxMeters: num(distance.maxMeters, 25000) },
    openTo: strings(raw.openTo),
    status: pick(raw.status, STATUSES, 'matching'),
    score: typeof raw.score === 'number' ? raw.score : null,
    headline: textOrNull(raw.headline),
  };
}

export function nearbyEntryOf(value: unknown): CgNearbyEntry {
  const raw = record(value);
  const requests = Array.isArray(raw.requests) ? raw.requests.map(record) : [];
  return { ...entryBase(raw), requests: requests.map((item) => ({ needId: text(item.needId), text: text(item.text) })).filter((item) => item.needId) };
}

export function nearbyResultsOf(value: unknown): CgNearbyResults {
  const raw = record(value);
  const people = Array.isArray(raw.people) ? raw.people.map(nearbyEntryOf).filter((entry) => entry.person.accountId) : [];
  return { people, matching: Math.max(0, num(raw.matching, 0)), location: locationOf(raw.location) };
}

const VERDICTS: readonly CgNearbyVerdict[] = ['met', 'unknown', 'not_met'];
const KINDS: readonly CgNearbyCheckKind[] = ['interest', 'work', 'affiliation', 'willingness'];

function checkOf(value: unknown): CgNearbyCheck {
  const raw = record(value);
  return {
    condition: num(raw.condition, 0),
    label: textOrNull(raw.label),
    verdict: pick(raw.verdict, VERDICTS, 'unknown'),
    kind: KINDS.includes(raw.kind as CgNearbyCheckKind) ? raw.kind as CgNearbyCheckKind : null,
    evidence: textOrNull(raw.evidence),
  };
}

function requestCheckOf(value: unknown): CgNearbyRequestCheck {
  const raw = record(value);
  return { needId: text(raw.needId), text: text(raw.text), met: raw.met === true, checks: Array.isArray(raw.checks) ? raw.checks.map(checkOf) : [] };
}

function cardOf(value: unknown): CgTopicLists {
  const raw = record(value);
  return { workingOn: strings(raw.workingOn), interests: strings(raw.interests), canHelp: strings(raw.canHelp), lookingFor: strings(raw.lookingFor) };
}

export function nearbyPersonOf(value: unknown): CgNearbyPerson {
  const raw = record(value);
  return {
    ...entryBase(raw),
    card: cardOf(raw.card),
    requests: Array.isArray(raw.requests) ? raw.requests.map(requestCheckOf).filter((item) => item.needId) : [],
    profileId: textOrNull(raw.profileId),
    ...(Array.isArray(raw.shared) ? { shared: raw.shared as CgNearbyPerson['shared'] } : {}),
    ...(Array.isArray(raw.youBring) ? { youBring: raw.youBring as CgNearbyPerson['youBring'] } : {}),
    ...(Array.isArray(raw.theyBring) ? { theyBring: raw.theyBring as CgNearbyPerson['theyBring'] } : {}),
    ...(typeof raw.nextStep === 'string' ? { nextStep: raw.nextStep } : {}),
  };
}

const NEED_STATUSES: readonly CgNeedStatus[] = ['active', 'scheduled', 'paused', 'ended'];

export function needOf(value: unknown): CgNeed {
  const raw = record(value);
  return {
    needId: text(raw.needId),
    text: text(raw.text),
    range: num(raw.range, 2000),
    startsAt: textOrNull(raw.startsAt),
    endsAt: textOrNull(raw.endsAt),
    paused: raw.paused === true,
    status: pick(raw.status, NEED_STATUSES, 'active'),
    revision: num(raw.revision, 1),
    createdAt: text(raw.createdAt),
    updatedAt: text(raw.updatedAt),
  };
}

/** The nearby routes, built on the Grounding client's `data` call. */
export function nearbyRoutes(data: Data) {
  return {
    postNearbyLocation: (fix: NearbyLocationInput) => data<{ location: CgNearbyLocation }>('POST', nb('/location'), fix),
    nearby: async () => nearbySettingsOf(await data<unknown>('GET', nb())),
    saveNearby: async (patch: CgNearbyPatch) => nearbySettingsOf(await data<unknown>('PUT', nb(), patch)),
    /** A range or score left out uses the stored settings; passing them does not change the settings. */
    nearbyPeople: async (filters: { range?: number; minScore?: number } = {}) => {
      const query = new URLSearchParams();
      if (filters.range !== undefined) query.set('range', String(filters.range));
      if (filters.minScore !== undefined) query.set('minScore', String(filters.minScore));
      const search = query.toString();
      return nearbyResultsOf(await data<unknown>('GET', nb(`/people${search ? `?${search}` : ''}`)));
    },
    nearbyPerson: async (accountId: string) => nearbyPersonOf(await data<unknown>('GET', nb(`/people/${enc(accountId)}`))),
    needs: async () => {
      const list = record(await data<unknown>('GET', nb('/needs')));
      return (Array.isArray(list.needs) ? list.needs.map(needOf) : []).filter((need) => need.needId);
    },
    createNeed: async (input: CgNeedInput) => needOf(await data<unknown>('POST', nb('/needs'), {
      text: input.text.trim(),
      range: input.range,
      ...(input.startsAt ? { startsAt: input.startsAt } : {}),
      ...(input.endsAt ? { endsAt: input.endsAt } : {}),
      ...(input.paused ? { paused: true } : {}),
    })),
    updateNeed: async (needId: string, patch: CgNeedPatch) => needOf(await data<unknown>('PUT', nb(`/needs/${enc(needId)}`), patch)),
    deleteNeed: (needId: string) => data<null>('DELETE', nb(`/needs/${enc(needId)}`)),
  };
}
