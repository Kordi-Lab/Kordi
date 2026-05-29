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
  mergePresenceEvent,
  presenceStatusForAccount,
  shouldRefreshPresenceForWsSubject,
  type CloudPresenceStore,
} from './presence';
import { loadSession } from './session';

const REFRESH_MS = 15_000;

type CloudPresenceStoreState = {
  snapshot: CloudPresenceStore;
  listeners: Set<() => void>;
  timer: ReturnType<typeof window.setInterval> | null;
  ws: WebSocket | null;
};

const stores = new Map<string, CloudPresenceStoreState>();

function storeFor(accountId: string): CloudPresenceStoreState {
  let store = stores.get(accountId);
  if (!store) {
    store = { snapshot: {}, listeners: new Set(), timer: null, ws: null };
    stores.set(accountId, store);
  }
  return store;
}

function publish(store: CloudPresenceStoreState, snapshot: CloudPresenceStore) {
  store.snapshot = snapshot;
  for (const listener of store.listeners) listener();
}

async function refresh(store: CloudPresenceStoreState, client: CloudAuthClient) {
  const session = await loadSession();
  if (!session?.token) return;
  const response = await client.listContactPresence(session.token);
  publish(store, applyPresenceSnapshot(store.snapshot, response));
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
  const store = account ? storeFor(account.accountId) : null;
  const [snapshot, setSnapshot] = useState<CloudPresenceStore>(() => store?.snapshot ?? {});

  useEffect(() => {
    if (!store || !account) {
      setSnapshot({});
      return;
    }
    const listener = () => setSnapshot(store.snapshot);
    store.listeners.add(listener);
    setSnapshot(store.snapshot);
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
  }, [account, client, store]);

  return {
    snapshot,
    statusForAccount: useCallback((accountId?: string | null) => presenceStatusForAccount(snapshot, accountId), [snapshot]),
  };
}
