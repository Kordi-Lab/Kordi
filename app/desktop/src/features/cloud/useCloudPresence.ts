import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  CloudAuthClient,
  cloudRealtimeWebSocketEnabled,
  cloudWebSocketUrl,
  defaultCloudAuthClient,
  type CloudAccount,
} from './authClient';
import {
  applyPresenceSnapshot,
  cloudPresenceChangedFromWsPayload,
  contactPresenceLabel,
  mergePresenceEvent,
  presenceStatusForAccount,
  shouldRefreshPresenceForWsSubject,
  type CloudPresenceAccount,
  type CloudPresenceStore,
} from './presence';
import { CLOUD_SESSION_SIGNED_OUT_EVENT, loadSession } from './session';

const REFRESH_MS = 15_000;
const LABEL_REFRESH_MS = 60_000;

type CloudPresenceStoreState = {
  snapshot: CloudPresenceStore;
  /** True once a full contact snapshot has arrived; until then presence is unknown, not offline. */
  loaded: boolean;
  /** Bumped on sign-out so a request that started before it cannot repopulate the store. */
  generation: number;
  listeners: Set<() => void>;
  timer: ReturnType<typeof window.setInterval> | null;
  ws: WebSocket | null;
};

type CloudPresenceView = { snapshot: CloudPresenceStore; ready: boolean };

// One store per account for the whole app, so every page, tab, and pane that
// mounts later starts from the presence already known instead of an empty one.
const stores = new Map<string, CloudPresenceStoreState>();
let signedOutListenerWindow: Window | null = null;

function resetPresenceStores() {
  for (const store of stores.values()) {
    store.generation += 1;
    if (!store.loaded && Object.keys(store.snapshot).length === 0) continue;
    store.snapshot = {};
    store.loaded = false;
    for (const listener of store.listeners) listener();
  }
}

function installSignedOutListener() {
  if (typeof window === 'undefined' || signedOutListenerWindow === window) return;
  signedOutListenerWindow = window;
  window.addEventListener(CLOUD_SESSION_SIGNED_OUT_EVENT, resetPresenceStores);
}

function storeFor(accountId: string): CloudPresenceStoreState {
  installSignedOutListener();
  let store = stores.get(accountId);
  if (!store) {
    store = { snapshot: {}, loaded: false, generation: 0, listeners: new Set(), timer: null, ws: null };
    stores.set(accountId, store);
  }
  return store;
}

function viewOf(store: CloudPresenceStoreState | null): CloudPresenceView {
  return { snapshot: store?.snapshot ?? {}, ready: store?.loaded ?? false };
}

function publish(store: CloudPresenceStoreState, snapshot: CloudPresenceStore, loaded = store.loaded) {
  if (Object.is(store.snapshot, snapshot) && store.loaded === loaded) return;
  store.snapshot = snapshot;
  store.loaded = loaded;
  for (const listener of store.listeners) listener();
}

async function refresh(store: CloudPresenceStoreState, client: CloudAuthClient) {
  const generation = store.generation;
  const session = await loadSession();
  if (!session?.token || generation !== store.generation) return;
  const response = await client.listContactPresence(session.token);
  if (generation !== store.generation) return;
  publish(store, applyPresenceSnapshot(store.snapshot, response), true);
}

/** Forgets every account's presence. Tests use it to start from a cold app. */
export function __resetCloudPresenceStoresForTests() {
  for (const store of stores.values()) {
    if (store.timer && typeof window !== 'undefined') window.clearInterval(store.timer);
    store.ws?.close();
  }
  stores.clear();
}

function ensurePresenceWebSocket(store: CloudPresenceStoreState) {
  if (store.ws || typeof WebSocket === 'undefined' || !cloudRealtimeWebSocketEnabled()) return;
  void loadSession().then((session) => {
    if (!session?.token || store.ws) return;
    const ws = new WebSocket(cloudWebSocketUrl(session.token));
    store.ws = ws;
    ws.onmessage = (event) => {
      try {
        const frame = JSON.parse(typeof event.data === 'string' ? event.data : '');
        if (!shouldRefreshPresenceForWsSubject(String(frame.subject ?? ''))) return;
        const changed = cloudPresenceChangedFromWsPayload(frame.payload);
        if (changed) publish(store, mergePresenceEvent(store.snapshot, changed));
      } catch {
        // Ignore malformed frames; polling refreshes the snapshot.
      }
    };
    ws.onclose = () => {
      if (store.ws === ws) store.ws = null;
    };
    ws.onerror = () => {
      ws.close();
    };
  }).catch(() => undefined);
}

export function useCloudPresence(account: CloudAccount | null) {
  const client = useMemo(() => defaultCloudAuthClient(), []);
  const accountId = account?.accountId;
  const store = useMemo(() => (accountId ? storeFor(accountId) : null), [accountId]);
  const [view, setView] = useState<CloudPresenceView>(() => viewOf(store));

  useEffect(() => {
    if (!store) {
      setView(viewOf(null));
      return;
    }
    const listener = () => setView((current) => (
      current.snapshot === store.snapshot && current.ready === store.loaded ? current : viewOf(store)
    ));
    store.listeners.add(listener);
    listener();
    void refresh(store, client).catch(() => undefined);
    ensurePresenceWebSocket(store);
    if (!store.timer && typeof window !== 'undefined') {
      store.timer = window.setInterval(() => void refresh(store, client).catch(() => undefined), REFRESH_MS);
    }
    return () => {
      store.listeners.delete(listener);
      if (store.listeners.size === 0) {
        if (store.timer && typeof window !== 'undefined') window.clearInterval(store.timer);
        store.timer = null;
        store.ws?.close();
        store.ws = null;
      }
    };
  }, [client, store]);

  const { snapshot, ready } = view;
  const statusForAccount = useCallback((accountId?: string | null) => presenceStatusForAccount(snapshot, accountId), [snapshot]);
  const presenceForAccount = useCallback((accountId?: string | null): CloudPresenceAccount | null | undefined => {
    if (!ready) return undefined;
    const id = accountId?.trim();
    return id ? snapshot[id] ?? null : null;
  }, [ready, snapshot]);
  // Consumers memoize on this object, so it must change only with presence.
  return useMemo(() => ({
    snapshot,
    /** False until the first contact snapshot arrives: presence is unknown, so show none. */
    ready,
    statusForAccount,
    /**
     * An account's presence: `undefined` while it is still unknown, `null` when the snapshot
     * has no entry for it, or its record.
     */
    presenceForAccount,
  }), [presenceForAccount, ready, snapshot, statusForAccount]);
}

export function useContactPresenceLabel(
  presence: CloudPresenceAccount | null | undefined,
) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const hasPresenceTarget = presence !== undefined;
  const lastSeenAt = presence?.lastSeenAt;
  const presenceStatus = presence?.status;
  useEffect(() => {
    if (!hasPresenceTarget || presenceStatus === 'online' || !lastSeenAt) return;
    const initialTimer = window.setTimeout(() => setNowMs(Date.now()), 0);
    const timer = window.setInterval(() => setNowMs(Date.now()), LABEL_REFRESH_MS);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(timer);
    };
  }, [hasPresenceTarget, lastSeenAt, presenceStatus]);
  return presence === undefined ? null : contactPresenceLabel(presence, { now: nowMs });
}
