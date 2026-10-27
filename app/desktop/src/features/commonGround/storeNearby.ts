// Grounding › Nearby state for one account, kept beside the main Grounding store (one per store):
// settings, search results, requests and nearby person pages. Views load what they show, refetch
// on the nearby hints, and poll quickly while people are still being matched.

import { commonGroundErrorCode, commonGroundErrorMessage, type CommonGroundClient } from './client';
import { nearbyPhase } from './nearbyFormat';
import type { CgScreen } from './store';
import type { CgNearbyAlerts, CgNearbyPatch, CgNearbyPerson, CgNearbyResults, CgNearbySettings, CgNeed, CgNeedInput, CgNeedPatch } from './typesNearby';

export const NEARBY_FAST_POLL_MS = 3_000;
export const NEARBY_SLOW_POLL_MS = 30_000;
const FAST_POLL_WINDOW_MS = 120_000;

export type CgNearbyState = {
  loaded: boolean;
  settings: CgNearbySettings | null;
  results: CgNearbyResults | null;
  /** What search last answered when it could not search: not taking part, or no current location. */
  blocked: 'off' | 'no_location' | null;
  needs: CgNeed[];
  needsLoaded: boolean;
  persons: Record<string, CgNearbyPerson>;
  /** One line for a person page that could not open, by account. */
  personNotices: Record<string, string>;
  notice: string | null;
  busy: string | null;
};

/** The parts of the main Grounding store Nearby uses. */
export type CgNearbyStoreHost = {
  readonly client: CommonGroundClient;
  open: (screen: CgScreen) => void;
};

const initialState = (): CgNearbyState => ({
  loaded: false,
  settings: null,
  results: null,
  blocked: null,
  needs: [],
  needsLoaded: false,
  persons: {},
  personNotices: {},
  notice: null,
  busy: null,
});

/** People still being matched, shown as "Matching N more"; none once matching failed. */
export function matchingCount(results: CgNearbyResults | null): number {
  if (!results || results.people.some((entry) => entry.status === 'failed')) return 0;
  return results.matching;
}

/** Errors after which a person is no longer visible through Nearby. */
const GONE = new Set(['common_ground_person_not_found', 'common_ground_nearby_off', 'common_ground_nearby_no_location']);

export class CgNearbyStore {
  private state = initialState();
  private listeners = new Set<() => void>();
  private peopleRequest = 0;
  private profileRevision = 0;
  private refreshing: Promise<void> | null = null;
  private refreshAgain = false;
  private watched = new Map<string, number>();
  private progressAt = Date.now();
  /** When the open view last refetched; polling waits from here. */
  fetchedAt = 0;

  constructor(readonly host: CgNearbyStoreHost) {}

  private get client() {
    return this.host.client;
  }

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  set(patch: Partial<CgNearbyState>) {
    if (patch.results && JSON.stringify([patch.results.matching, patch.results.people]) !== JSON.stringify([this.state.results?.matching, this.state.results?.people])) this.progressAt = Date.now();
    if (patch.persons && JSON.stringify(patch.persons) !== JSON.stringify(this.state.persons)) this.progressAt = Date.now();
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  phase(now = Date.now()) {
    return nearbyPhase(this.state.settings, this.state.blocked, now);
  }

  /** Keeps a person page fresh on hints while it is open. */
  watch(accountId: string): () => void {
    this.watched.set(accountId, (this.watched.get(accountId) ?? 0) + 1);
    return () => {
      const left = (this.watched.get(accountId) ?? 1) - 1;
      if (left > 0) this.watched.set(accountId, left);
      else this.watched.delete(accountId);
    };
  }

  /** Settings, then people when Nearby can search, and the requests for the Nearby screen. */
  async load(options: { needs?: boolean } = {}): Promise<void> {
    const needs = options.needs ? this.loadNeeds() : Promise.resolve();
    if (await this.loadSettings() && this.phase() === 'on') await this.loadPeople();
    await needs;
    this.fetchedAt = Date.now();
  }

  async loadSettings(): Promise<boolean> {
    if (this.state.busy === 'profile') return false;
    const revision = this.profileRevision;
    try {
      const settings = await this.client.nearby();
      if (revision !== this.profileRevision || this.state.busy === 'profile') return false;
      this.set({ settings, blocked: null, loaded: true });
      return true;
    } catch (error) {
      if (revision !== this.profileRevision) return false;
      this.set({ loaded: true, notice: commonGroundErrorMessage(error) });
      return false;
    }
  }

  /** Search with the stored range and score; only the newest search lands. */
  async loadPeople(): Promise<void> {
    if (this.state.busy === 'profile') return;
    const mine = ++this.peopleRequest;
    try {
      const results = await this.client.nearbyPeople();
      if (mine === this.peopleRequest) this.set({ results, blocked: null });
    } catch (error) {
      if (mine !== this.peopleRequest) return;
      const code = commonGroundErrorCode(error);
      if (code === 'common_ground_nearby_off') this.set({ blocked: 'off', results: null });
      else if (code === 'common_ground_nearby_no_location') this.set({ blocked: 'no_location', results: null });
      else this.set({ notice: commonGroundErrorMessage(error) });
    }
  }

  async loadNeeds(): Promise<void> {
    try {
      this.set({ needs: await this.client.needs(), needsLoaded: true });
    } catch (error) {
      this.set({ notice: commonGroundErrorMessage(error) });
    }
  }

  async loadPerson(accountId: string): Promise<void> {
    if (this.state.busy === 'profile') return;
    const revision = this.profileRevision;
    try {
      const person = await this.client.nearbyPerson(accountId);
      if (revision !== this.profileRevision) return;
      const { [accountId]: _cleared, ...personNotices } = this.state.personNotices;
      this.set({ persons: { ...this.state.persons, [accountId]: person }, personNotices });
    } catch (error) {
      if (revision !== this.profileRevision) return;
      const gone = GONE.has(commonGroundErrorCode(error) ?? '');
      const { [accountId]: _dropped, ...persons } = this.state.persons;
      this.set({ persons: gone ? persons : this.state.persons, personNotices: { ...this.state.personNotices, [accountId]: commonGroundErrorMessage(error) } });
    } finally {
      this.fetchedAt = Date.now();
    }
  }

  /** After a nearby hint: what the open views show. Hints that arrive during a refresh run it once more. */
  refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      do {
        this.refreshAgain = false;
        await this.load({ needs: this.state.needsLoaded });
        await Promise.all([...this.watched.keys()].map((accountId) => this.loadPerson(accountId)));
      } while (this.refreshAgain);
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  /** The delay before the open view refetches: quick while anyone shown is being matched. */
  pollDelay(accountId?: string, now = Date.now()): number {
    if (this.phase(now) !== 'on' || now - this.progressAt >= FAST_POLL_WINDOW_MS) return NEARBY_SLOW_POLL_MS;
    if (accountId) return this.state.persons[accountId]?.status === 'matching' ? NEARBY_FAST_POLL_MS : NEARBY_SLOW_POLL_MS;
    const results = this.state.results;
    const matching = matchingCount(results) > 0 || Boolean(results?.people.some((entry) => entry.status === 'matching'));
    return matching ? NEARBY_FAST_POLL_MS : NEARBY_SLOW_POLL_MS;
  }

  async poll(accountId?: string): Promise<void> {
    if (accountId) await this.loadPerson(accountId);
    else await this.load();
    this.fetchedAt = Date.now();
  }

  // Settings

  private async save(key: string, patch: CgNearbyPatch, optimistic: Partial<CgNearbySettings> = {}): Promise<boolean> {
    const before = this.state.settings;
    this.set({ busy: key, notice: null, ...(before ? { settings: { ...before, ...optimistic } } : {}) });
    try {
      this.set({ settings: await this.client.saveNearby(patch), blocked: null });
      return true;
    } catch (error) {
      this.set({ settings: before, notice: commonGroundErrorMessage(error) });
      return false;
    } finally {
      if (this.state.busy === key) this.set({ busy: null });
    }
  }

  private async researchIfOn() {
    this.progressAt = Date.now();
    if (this.phase() === 'on') await this.loadPeople();
    else this.set({ results: null });
  }

  /** Consents and turns Nearby on, sharing `profileId`; background alerts set both alert switches. */
  async turnOn(profileId: string, background: boolean): Promise<boolean> {
    this.set({ busy: 'enable', notice: null });
    try {
      const settings = await this.client.saveNearby({
        enabled: true, consent: true, profileId, pausedUntil: null, alerts: { requests: background, matches: background },
      });
      this.set({ settings, blocked: null, results: null });
    } catch (error) {
      if (commonGroundErrorCode(error) === 'common_ground_no_card') this.host.open({ name: 'build' });
      else this.set({ notice: commonGroundErrorMessage(error) });
      return false;
    } finally {
      if (this.state.busy === 'enable') this.set({ busy: null });
    }
    await this.researchIfOn();
    return true;
  }

  /** Hides you and stops search and alerts at once; settings and requests are kept. */
  async turnOff(): Promise<void> {
    if (await this.save('enable', { enabled: false }, { enabled: false, participating: false })) this.set({ results: null });
  }

  /** `until` is an ISO time at most 7 days ahead, or null to resume. */
  async pause(until: string | null): Promise<void> {
    if (await this.save('pause', { pausedUntil: until }, { pausedUntil: until })) await this.researchIfOn();
  }

  /** Stores the range or minimum score, then searches again with them. */
  async setFilters(filters: { range?: number; minScore?: number }): Promise<void> {
    if (await this.save('filters', filters, filters)) await this.researchIfOn();
  }

  setOpenTo = async (openTo: string[], profileId = this.state.settings?.profileId) => {
    if (this.state.busy || !profileId || profileId !== this.state.settings?.profileId) return;
    if (!await this.save('openTo', { openTo, openToProfileId: profileId }, { openTo })) await this.loadSettings();
  };

  setAlerts = async (alerts: Partial<CgNearbyAlerts>) => {
    const current = this.state.settings?.alerts;
    await this.save('alerts', { alerts }, current ? { alerts: { ...current, ...alerts } } : {});
  };

  /** Shares another card through Nearby. */
  async setProfile(profileId: string): Promise<boolean> {
    if (this.state.busy === 'profile') return false;
    this.profileRevision += 1;
    this.peopleRequest += 1;
    this.set({ results: null, persons: {}, personNotices: {} });
    const saved = await this.save('profile', { profileId }, { profileId, openTo: [] });
    await this.researchIfOn();
    return saved;
  }

  // Requests

  private async needWork(key: string, work: () => Promise<CgNeed[]>): Promise<boolean> {
    this.set({ busy: key, notice: null });
    try {
      this.set({ needs: await work() });
    } catch (error) {
      this.set({ notice: commonGroundErrorMessage(error) });
      return false;
    } finally {
      if (this.state.busy === key) this.set({ busy: null });
    }
    // Who meets which request can change; search again.
    if (this.phase() === 'on') void this.loadPeople();
    return true;
  }

  createNeed = (input: CgNeedInput) => this.needWork('need', async () => {
    const need = await this.client.createNeed(input);
    return [need, ...this.state.needs.filter((item) => item.needId !== need.needId)];
  });

  updateNeed = (needId: string, patch: CgNeedPatch) => this.needWork('need', async () => {
    const need = await this.client.updateNeed(needId, patch);
    return this.state.needs.map((item) => (item.needId === needId ? need : item));
  });

  deleteNeed = (needId: string) => this.needWork('need', async () => {
    await this.client.deleteNeed(needId);
    return this.state.needs.filter((item) => item.needId !== needId);
  });
}

const stores = new WeakMap<CgNearbyStoreHost, CgNearbyStore>();

/** The Nearby store beside a Grounding store. */
export function nearbyStoreFor(host: CgNearbyStoreHost): CgNearbyStore {
  let store = stores.get(host);
  if (!store) {
    store = new CgNearbyStore(host);
    stores.set(host, store);
  }
  return store;
}
