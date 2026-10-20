// Common ground state for one signed-in account: the screen stack, the
// owner's card, rooms, results and matches. Polling is driven by `poll()`,
// which refreshes whatever the top screen is waiting on and returns the delay
// before the next refresh, or null when nothing is pending.

import { CommonGroundError, commonGroundErrorCode, commonGroundErrorMessage, isRouteMissing, type CommonGroundClient } from './client';
import type {
  CgBuildRequest, CgMatch, CgOwnerView, CgPersonCard, CgRecentEntry, CgRelationship, CgResults, CgRoom,
  CgRoomSummary, CgTopicLists,
} from './types';

export type CgScreen =
  | { name: 'home' }
  | { name: 'build' }
  | { name: 'card' }
  | { name: 'lobby'; code: string }
  | { name: 'results'; code: string }
  | { name: 'match'; accountId: string }
  | { name: 'person'; accountId: string };

/** Routes the server may not have yet; a 404 without an error code turns one off. */
export type CgSupport = { contact: boolean; chat: boolean; meet: boolean; group: boolean; invitations: boolean; rooms: boolean };

export type CgState = {
  stack: CgScreen[];
  owner: CgOwnerView | null;
  loaded: boolean;
  recent: CgRecentEntry[];
  /** Rooms the viewer joined and has not left, newest first. */
  roomList: CgRoomSummary[];
  rooms: Record<string, CgRoom>;
  results: Record<string, CgResults>;
  matches: Record<string, CgMatch>;
  people: Record<string, CgPersonCard>;
  /** Local relationship updates after an action, by account. */
  relationships: Record<string, CgRelationship>;
  support: CgSupport;
  /** One line for the current screen. */
  notice: string | null;
  busy: string | null;
};

export const LOBBY_POLL_MS = 2_000;
export const MATCH_POLL_MS = 3_000;
export const BUILD_POLL_MS = 3_000;

const initialState = (): CgState => ({
  stack: [{ name: 'home' }],
  owner: null,
  loaded: false,
  recent: [],
  roomList: [],
  rooms: {},
  results: {},
  matches: {},
  people: {},
  relationships: {},
  support: { contact: true, chat: true, meet: true, group: true, invitations: true, rooms: true },
  notice: null,
  busy: null,
});

/** True when the server says the room has closed, from the room or the rooms list. */
export function roomClosed(state: CgState, code: string): boolean {
  return state.rooms[code]?.open === false || state.roomList.some((room) => room.code === code && !room.open);
}

const BUILD_ERRORS: Record<string, string> = {
  common_ground_no_sources: 'Turn on a source first.',
  common_ground_build_in_progress: 'Your card is already being built.',
};

export class CommonGroundStore {
  private state = initialState();
  private listeners = new Set<() => void>();
  private disposed = false;

  constructor(private readonly client: CommonGroundClient) {}

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private set(patch: Partial<CgState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  dispose() {
    this.disposed = true;
    this.listeners.clear();
  }

  top(): CgScreen {
    return this.state.stack[this.state.stack.length - 1];
  }

  private async run<T>(key: string, work: () => Promise<T>): Promise<T | null> {
    this.set({ busy: key, notice: null });
    try {
      return await work();
    } catch (error) {
      this.set({ notice: commonGroundErrorMessage(error) });
      return null;
    } finally {
      if (this.state.busy === key) this.set({ busy: null });
    }
  }

  private unsupported(error: unknown, route: keyof CgSupport): boolean {
    if (!isRouteMissing(error)) return false;
    this.set({ support: { ...this.state.support, [route]: false } });
    return true;
  }

  // Navigation

  open(screen: CgScreen) {
    this.set({ stack: [...this.state.stack, screen], notice: null });
    void this.loadScreen(screen);
  }

  replace(screen: CgScreen) {
    this.set({ stack: [...this.state.stack.slice(0, -1), screen], notice: null });
    void this.loadScreen(screen);
  }

  back() {
    if (this.state.stack.length <= 1) return;
    this.set({ stack: this.state.stack.slice(0, -1), notice: null });
    if (this.top().name === 'home') void this.loadRooms();
  }

  home() {
    this.set({ stack: [{ name: 'home' }], notice: null });
    void this.loadHome();
  }

  async loadScreen(screen: CgScreen = this.top()): Promise<void> {
    try {
      switch (screen.name) {
        case 'home': return await this.loadHome();
        case 'lobby': return this.set({ rooms: { ...this.state.rooms, [screen.code]: await this.client.room(screen.code) } });
        case 'results': {
          const room = this.client.room(screen.code).catch(() => null);
          const results = await this.client.results(screen.code);
          const loaded = await room;
          return this.set({
            results: { ...this.state.results, [screen.code]: results },
            rooms: loaded ? { ...this.state.rooms, [screen.code]: loaded } : this.state.rooms,
          });
        }
        case 'match': return this.set({ matches: { ...this.state.matches, [screen.accountId]: await this.client.match(screen.accountId) } });
        case 'person': return this.set({ people: { ...this.state.people, [screen.accountId]: await this.client.person(screen.accountId) } });
        default: return undefined;
      }
    } catch (error) {
      this.set({ notice: commonGroundErrorMessage(error) });
    }
  }

  async loadHome(): Promise<void> {
    try {
      const owner = await this.client.card();
      this.set({ owner, loaded: true });
      if (!owner.card) return;
      const [recent] = await Promise.all([this.client.recent().catch(() => ({ people: this.state.recent })), this.loadRooms()]);
      this.set({ recent: recent.people });
    } catch (error) {
      this.set({ loaded: true, notice: commonGroundErrorMessage(error) });
    }
  }

  /** Refreshes the Rooms list; an older server without the route hides it. */
  async loadRooms(): Promise<void> {
    if (!this.state.support.rooms) return;
    try {
      this.set({ roomList: await this.client.rooms() });
    } catch (error) {
      if (isRouteMissing(error)) this.set({ support: { ...this.state.support, rooms: false }, roomList: [] });
    }
  }

  /** Refreshes what the top screen waits on; returns the next delay or null. */
  async poll(): Promise<number | null> {
    const screen = this.top();
    try {
      if (this.state.owner?.build.status === 'building') {
        const owner = await this.client.card();
        this.applyOwner(owner);
        return owner.build.status === 'building' ? BUILD_POLL_MS : null;
      }
      if (screen.name === 'lobby') {
        const room = await this.client.room(screen.code);
        this.set({ rooms: { ...this.state.rooms, [screen.code]: room } });
        return LOBBY_POLL_MS;
      }
      if (screen.name === 'results' && this.state.results[screen.code]?.status === 'matching' && !roomClosed(this.state, screen.code)) {
        const results = await this.client.results(screen.code);
        this.set({ results: { ...this.state.results, [screen.code]: results } });
        return results.status === 'matching' ? MATCH_POLL_MS : null;
      }
      if (screen.name === 'match' && this.state.matches[screen.accountId]?.status === 'matching') {
        const match = await this.client.match(screen.accountId);
        this.set({ matches: { ...this.state.matches, [screen.accountId]: match } });
        return match.status === 'matching' ? MATCH_POLL_MS : null;
      }
    } catch (error) {
      if (commonGroundErrorCode(error) === 'common_ground_room_not_found' && screen.name === 'lobby') {
        this.home();
        this.set({ notice: 'Room not found.' });
        return null;
      }
      return screen.name === 'lobby' ? LOBBY_POLL_MS : MATCH_POLL_MS;
    }
    return null;
  }

  private applyOwner(owner: CgOwnerView) {
    const wasBuilding = this.state.owner?.build.status === 'building';
    this.set({ owner, loaded: true });
    if (!wasBuilding || owner.build.status === 'building') return;
    if (owner.build.status === 'failed') {
      this.set({ notice: 'Could not build your card. Try again.' });
    } else if (owner.card && this.top().name === 'build') {
      this.home();
    }
  }

  // Card

  async build(request: CgBuildRequest): Promise<void> {
    await this.run('build', async () => {
      try {
        this.applyOwner(await this.client.build(request));
      } catch (error) {
        const code = commonGroundErrorCode(error);
        if (code && BUILD_ERRORS[code]) throw new CommonGroundError(BUILD_ERRORS[code], 409, code);
        throw error;
      }
    });
  }

  async saveTopics(lists: CgTopicLists): Promise<void> {
    const owner = this.state.owner;
    if (!owner?.card) return;
    this.set({ owner: { ...owner, card: { ...owner.card, ...lists } } });
    const saved = await this.run('topics', () => this.client.saveTopics(lists));
    this.set({ owner: saved ?? owner, matches: saved ? {} : this.state.matches });
  }

  async toggleHidden(topic: string): Promise<void> {
    const card = this.state.owner?.card;
    if (!card) return;
    const hidden = card.hidden.includes(topic) ? card.hidden.filter((item) => item !== topic) : [...card.hidden, topic];
    const saved = await this.run('hidden', () => this.client.setHidden(hidden));
    if (saved) this.set({ owner: saved });
  }

  async setSharing(sharing: boolean): Promise<void> {
    const saved = await this.run('sharing', () => this.client.setSharing(sharing));
    if (saved) this.set({ owner: saved });
  }

  async deleteCard(): Promise<boolean> {
    const view = await this.run('delete', () => this.client.deleteCard());
    if (!view) return false;
    this.set({ ...initialState(), owner: view, loaded: true, support: this.state.support });
    return true;
  }

  // Rooms

  async joinRoom(code: string): Promise<boolean> {
    try {
      this.set({ busy: 'join', notice: null });
      const room = await this.client.joinRoom(code);
      this.set({ rooms: { ...this.state.rooms, [code]: room }, stack: [...this.state.stack, { name: 'lobby', code }] });
      void this.loadRooms();
      return true;
    } catch (error) {
      const code = commonGroundErrorCode(error);
      if (code === 'common_ground_no_card') this.open({ name: 'build' });
      else this.set({ notice: commonGroundErrorMessage(error) });
      return false;
    } finally {
      this.set({ busy: null });
    }
  }

  async leaveRoom(code: string): Promise<void> {
    await this.client.leaveRoom(code).catch(() => undefined);
    const { [code]: _room, ...rooms } = this.state.rooms;
    const { [code]: _results, ...results } = this.state.results;
    this.set({ rooms, results, roomList: this.state.roomList.filter((room) => room.code !== code) });
    this.home();
  }

  async findCommonGround(code: string): Promise<void> {
    const results = await this.run('find', () => this.client.results(code));
    if (!results) return;
    this.set({ results: { ...this.state.results, [code]: results } });
    this.set({ stack: [...this.state.stack.slice(0, -1), { name: 'results', code }] });
  }

  /** Opens Results for a room from the Rooms list. */
  openRoom(code: string) {
    this.open({ name: 'results', code });
  }

  async createGroup(code: string, name: string, memberIds: string[], topic?: string) {
    try {
      this.set({ busy: 'group', notice: null });
      const created = await this.client.createGroup(code, name, memberIds, topic);
      const results = this.state.results[code];
      if (results) {
        const groups = [...(results.groups ?? []), { ...created.group, topic: created.group.topic ?? topic ?? null, joined: true }];
        this.set({ results: { ...this.state.results, [code]: { ...results, groups } } });
      }
      return created;
    } catch (error) {
      if (!this.unsupported(error, 'group')) this.set({ notice: commonGroundErrorMessage(error) });
      return null;
    } finally {
      this.set({ busy: null });
    }
  }

  async joinInvitation(code: string, ref: string): Promise<string | null> {
    try {
      const joined = await this.client.joinInvitation(code, ref);
      const results = this.state.results[code];
      if (results) {
        const invitations = (results.invitations ?? []).filter((item) => item.invitationRef !== ref);
        const groups = [...(results.groups ?? []).filter((group) => group.groupSpaceId !== joined.groupSpaceId),
          { groupSpaceId: joined.groupSpaceId, conversationId: joined.conversationId, name: joined.name, memberCount: 0, joined: true }];
        this.set({ results: { ...this.state.results, [code]: { ...results, invitations, groups } } });
      }
      return joined.groupSpaceId;
    } catch (error) {
      if (!this.unsupported(error, 'invitations')) this.set({ notice: commonGroundErrorMessage(error) });
      return null;
    }
  }

  // People

  setRelationship(accountId: string, relationship: CgRelationship) {
    this.set({ relationships: { ...this.state.relationships, [accountId]: relationship } });
  }

  async addContact(accountId: string): Promise<void> {
    try {
      const { relationship } = await this.client.addContact(accountId);
      this.setRelationship(accountId, relationship);
    } catch (error) {
      if (commonGroundErrorCode(error) === 'already_contact') {
        this.setRelationship(accountId, { ...this.relationshipFor(accountId), contact: true, request: null, requestId: null } as CgRelationship);
      } else if (!this.unsupported(error, 'contact')) {
        this.set({ notice: commonGroundErrorMessage(error) });
      }
    }
  }

  /** Opens the direct conversation on the server; false when the people are not contacts. */
  async chat(accountId: string): Promise<boolean> {
    try {
      const { relationship } = await this.client.chat(accountId);
      this.setRelationship(accountId, relationship);
      return true;
    } catch (error) {
      if (this.unsupported(error, 'chat')) return true;
      const body = error instanceof CommonGroundError ? error.body as { relationship?: CgRelationship } | null : null;
      if (body?.relationship) this.setRelationship(accountId, body.relationship);
      this.set({ notice: commonGroundErrorMessage(error) });
      return false;
    }
  }

  async meet(accountId: string, input: { title?: string; startAt: string; endAt?: string }): Promise<boolean> {
    try {
      const { relationship } = await this.client.meet(accountId, input);
      this.setRelationship(accountId, relationship);
      return true;
    } catch (error) {
      if (!this.unsupported(error, 'meet')) this.set({ notice: commonGroundErrorMessage(error) });
      return false;
    }
  }

  /** The newest relationship known for a person, from any view that carries one. */
  relationshipFor(accountId: string): CgRelationship | undefined {
    const s = this.state;
    if (s.relationships[accountId]) return s.relationships[accountId];
    const candidates = [
      s.matches[accountId]?.person,
      s.people[accountId]?.person,
      ...Object.values(s.results).flatMap((results) => results.people.map((entry) => entry.person)),
      ...Object.values(s.rooms).flatMap((room) => room.members),
      ...s.recent.map((entry) => entry.person),
    ];
    return candidates.find((person) => person?.accountId === accountId && person.relationship)?.relationship;
  }
}
