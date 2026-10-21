import { useEffect, useSyncExternalStore } from 'react';

import { cloudApiBaseUrl } from '@/features/cloud/cloudApiEnvironment';
import { CLOUD_SESSION_CHANGED_EVENT, CLOUD_SESSION_SIGNED_OUT_EVENT } from '@/features/cloud/session';
import { createCommonGroundClient } from './client';
import { localProfileMemory } from './profiles';
import { CommonGroundStore } from './store';

const IDLE_CHECK_MS = 1_000;
const stores = new Map<string, CommonGroundStore>();
let listening = false;

/** One store per server, account and route version; a session change drops them all. */
export function commonGroundStoreFor(accountId: string, profiles = false): CommonGroundStore {
  if (!listening && typeof window !== 'undefined') {
    listening = true;
    const clear = () => {
      stores.forEach((store) => store.dispose());
      stores.clear();
    };
    window.addEventListener(CLOUD_SESSION_CHANGED_EVENT, clear);
    window.addEventListener(CLOUD_SESSION_SIGNED_OUT_EVENT, clear);
  }
  const key = JSON.stringify([cloudApiBaseUrl(), accountId, profiles]);
  let store = stores.get(key);
  if (!store) {
    store = new CommonGroundStore(createCommonGroundClient(), { profiles, memory: localProfileMemory(accountId) });
    stores.set(key, store);
  }
  return store;
}

/** Store state, with polling while mounted and the window is visible. */
export function useCommonGround(store: CommonGroundStore) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = async () => {
      let next: number | null = null;
      if (!document.hidden) next = await store.poll();
      if (!stopped) timer = setTimeout(loop, next ?? IDLE_CHECK_MS);
    };
    if (!store.getSnapshot().loaded) void store.loadHome();
    else if (store.top().name === 'home') void store.loadRooms();
    if (store.top().name !== 'home') void store.loadScreen();
    timer = setTimeout(loop, IDLE_CHECK_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [store]);
  return state;
}
