import { CommonGroundError, commonGroundErrorMessage } from './client';
import { personKey, type CgScreen, type CgState, type CommonGroundStore } from './store';
import type { CgRoomSummary } from './types';

/** A fresh denial invalidates loaded content; a network failure does not. */
export function clearUnavailableScreen(store: CommonGroundStore, screen: CgScreen, error: unknown): boolean {
  if (!(error instanceof CommonGroundError) || ![403, 404].includes(error.status) || error.routeMissing) return false;
  const state = store.getSnapshot();
  if (screen.name === 'lobby' || screen.name === 'results') {
    const { [screen.code]: _room, ...rooms } = state.rooms;
    const { [screen.code]: _results, ...results } = state.results;
    store.set({ rooms, results, roomList: state.roomList.filter((room) => room.code !== screen.code) });
    if (store.top() === screen) store.home();
  } else if (screen.name === 'match' || screen.name === 'person') {
    const key = personKey(screen.accountId, screen.profileId);
    const { [key]: _match, ...matches } = state.matches;
    const { [key]: _person, ...people } = state.people;
    store.set({ matches, people });
  }
  store.set({ notice: error.message });
  return true;
}

/** The authoritative room list also removes snapshots for memberships withdrawn elsewhere. */
export function reconcileRooms(store: CommonGroundStore, roomList: CgRoomSummary[]) {
  const codes = new Set(roomList.map((room) => room.code));
  const state = store.getSnapshot();
  const rooms = Object.fromEntries(Object.entries(state.rooms).filter(([code]) => codes.has(code)));
  const results = Object.fromEntries(Object.entries(state.results).filter(([code]) => codes.has(code)));
  store.set({ roomList, rooms, results });
}

export async function refreshScreen(store: CommonGroundStore, screen: CgScreen): Promise<void> {
  const snapshot = store.getSnapshot;
  const before = snapshot();
  const apply = (patch: Partial<CgState>) => {
    if (snapshot() === before) store.set(patch);
  };
  try {
    switch (screen.name) {
      case 'home': return store.loadHome();
      case 'lobby': return apply({ rooms: { ...snapshot().rooms, [screen.code]: await store.client.room(screen.code) } });
      case 'results': {
        const room = store.client.room(screen.code).catch(() => null);
        const results = await store.client.results(screen.code);
        const loaded = await room;
        return apply({
          results: { ...snapshot().results, [screen.code]: results },
          rooms: loaded ? { ...snapshot().rooms, [screen.code]: loaded } : snapshot().rooms,
        });
      }
      case 'match': {
        const match = await store.client.match(screen.accountId, screen.profileId);
        return apply({ matches: { ...snapshot().matches, [personKey(screen.accountId, screen.profileId)]: match } });
      }
      case 'person': {
        const view = await store.client.person(screen.accountId, screen.profileId);
        return apply({ people: { ...snapshot().people, [personKey(screen.accountId, screen.profileId)]: view } });
      }
      default: return undefined;
    }
  } catch (error) {
    clearUnavailableScreen(store, screen, error);
    apply({ notice: commonGroundErrorMessage(error) });
  }
}
