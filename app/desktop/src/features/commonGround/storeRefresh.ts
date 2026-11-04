import { CommonGroundError, commonGroundErrorMessage } from './client';
import { personKey, type CgScreen, type CgState, type CommonGroundStore } from './store';
import type { CgRoomSummary } from './types';

function filterCaches(state: CgState, fields: Array<'rooms' | 'results' | 'matches' | 'people'>, keep: (id: string) => boolean): Partial<CgState> {
  return Object.fromEntries(fields.map((field) => {
    const cache = { ...state[field] };
    for (const id in cache) if (!keep(id)) delete cache[id];
    return [field, cache];
  }));
}

/** The authoritative room list also removes snapshots for memberships withdrawn elsewhere. */
export function reconcileRooms(store: CommonGroundStore, roomList: CgRoomSummary[]) {
  const codes = new Set(roomList.map((room) => room.code));
  store.set({ roomList, ...filterCaches(store.getSnapshot(), ['rooms', 'results'], (code) => codes.has(code)) });
}

export async function refreshScreen(store: CommonGroundStore, screen: CgScreen): Promise<void> {
  const snapshot = store.getSnapshot;
  const before = snapshot();
  const patch: Partial<CgState> = {};
  const cache = <K extends 'rooms' | 'results' | 'matches' | 'people'>(key: K, id: string, value: CgState[K][string]) => {
    patch[key] = { ...before[key], [id]: value };
  };
  try {
    switch (screen.name) {
      case 'home': return store.loadHome();
      case 'lobby': cache('rooms', screen.code, await store.client.room(screen.code)); break;
      case 'results': {
        const room = store.client.room(screen.code).catch(() => null);
        cache('results', screen.code, await store.client.results(screen.code));
        const loaded = await room;
        if (loaded) cache('rooms', screen.code, loaded);
        break;
      }
      case 'match':
      case 'person': {
        const { accountId, profileId } = screen;
        cache(screen.name === 'match' ? 'matches' : 'people', personKey(accountId, profileId),
          await store.client[screen.name](accountId, profileId));
        break;
      }
      default: return;
    }
    if (snapshot() === before) store.set(patch);
  } catch (error) {
    const state = snapshot();
    // A fresh denial invalidates loaded content; transient errors preserve it for retry.
    if (error instanceof CommonGroundError && [403, 404].includes(error.status) && !error.routeMissing) {
      if ('code' in screen) {
        store.set({ ...filterCaches(state, ['rooms', 'results'], (code) => code !== screen.code),
          roomList: state.roomList.filter((room) => room.code !== screen.code) });
        if (store.top() === screen) store.home();
      } else if (screen.name === 'match' || screen.name === 'person') {
        const key = personKey(screen.accountId, screen.profileId);
        store.set(filterCaches(state, ['matches', 'people'], (id) => id !== key));
      }
    } else if (state !== before) return;
    store.set({ notice: commonGroundErrorMessage(error) });
  }
}
