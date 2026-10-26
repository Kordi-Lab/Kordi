// Shapes of the `/v1/cloud/common-ground/nearby…` routes (`commonGroundNearbyVersion` 1,
// docs/development/grounding-nearby.md), camelCase as the server sends them.

import type { CgMatchStatus, CgPerson, CgReason, CgTopicLists, CgTrade } from './types';

/** A distance band's `maxMeters`; the range filter and requests take one of them. */
export const CG_NEARBY_RANGES = [500, 1000, 2000, 5000, 10000, 25000] as const;
export const CG_NEARBY_MIN_SCORES = [0, 50, 70, 85] as const;
export const CG_NEARBY_PER_DAY = [1, 3, 10] as const;

/** The account's newest location row, fresh or not, from any signed-in device. */
export type CgNearbyLocation = { capturedAt: string; freshUntil: string; fresh: boolean };

export type CgNearbyAlerts = { requests: boolean; matches: boolean; matchMinScore: number; maxPerDay: number };

/** `GET nearby`: the viewer's settings and whether they take part right now. */
export type CgNearbySettings = {
  enabled: boolean;
  participating: boolean;
  pausedUntil: string | null;
  consentedAt: string | null;
  profileId: string | null;
  openTo: string[];
  range: number;
  minScore: number;
  alerts: CgNearbyAlerts;
  location: CgNearbyLocation | null;
  freshSeconds: number;
};

/** `PUT nearby` writes only the fields present; turning on needs `consent: true`. */
export type CgNearbyPatch = Partial<Pick<CgNearbySettings, 'enabled' | 'profileId' | 'pausedUntil' | 'openTo' | 'range' | 'minScore'>> & {
  consent?: boolean;
  alerts?: Partial<CgNearbyAlerts>;
};

/** Other people's distance, only ever as a band. */
export type CgNearbyDistance = { minMeters: number; maxMeters: number };

/** One of the viewer's active requests this person meets. */
export type CgNearbyMet = { needId: string; text: string };

/** A search entry; the server's `relationship` is folded into `person`. */
export type CgNearbyEntry = {
  person: CgPerson;
  distance: CgNearbyDistance;
  openTo: string[];
  status: CgMatchStatus;
  score: number | null;
  headline: string | null;
  requests: CgNearbyMet[];
};

/** `GET nearby/people`: `matching` counts people still being matched. */
export type CgNearbyResults = { people: CgNearbyEntry[]; matching: number; location: CgNearbyLocation | null };

export type CgNearbyVerdict = 'met' | 'unknown' | 'not_met';
export type CgNearbyCheckKind = 'interest' | 'work' | 'affiliation' | 'willingness';

/** One condition of a request, checked against what the person shares. `label` is the condition's text. */
export type CgNearbyCheck = { condition: number; label: string | null; verdict: CgNearbyVerdict; kind: CgNearbyCheckKind | null; evidence: string | null };

export type CgNearbyRequestCheck = { needId: string; text: string; met: boolean; checks: CgNearbyCheck[] };

/** `GET nearby/people/:id`: the entry with their shared card, your request checks and the match when stored. */
export type CgNearbyPerson = Omit<CgNearbyEntry, 'requests'> & {
  card: CgTopicLists;
  requests: CgNearbyRequestCheck[];
  /** The viewer's nearby profile. */
  profileId: string | null;
  shared?: CgReason[];
  youBring?: CgTrade[];
  theyBring?: CgTrade[];
  nextStep?: string | null;
};

export type CgNeedStatus = 'active' | 'scheduled' | 'paused' | 'ended';

/** A request: who the viewer wants to meet nearby, with no end or a window that ends within 7 days. */
export type CgNeed = {
  needId: string;
  text: string;
  range: number;
  startsAt: string | null;
  endsAt: string | null;
  paused: boolean;
  status: CgNeedStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

/** `POST nearby/needs`, and `PUT nearby/needs/:id` with only the changed fields (a null time clears it). */
export type CgNeedInput = { text: string; range: number; startsAt: string | null; endsAt: string | null; paused: boolean };
export type CgNeedPatch = Partial<CgNeedInput>;
