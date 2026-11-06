// Per-account store for the private block list. It is separate from the
// contacts store so a server without blocking (an empty 404) never disturbs
// contact refreshes, and it doubles as the availability signal for Block and
// Report.

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

import { CLOUD_DIRECTORY_SYNC_EVENT } from '@/features/cloud/cloudDeviceEvents';

import { defaultSafetyDeps, isMissingRoute, safetySessionToken, type SafetyDeps } from './safetyClient';
import type { CloudBlockedAccount } from './safetyTypes';

export type CloudBlocksSnapshot = {
  blocks: CloudBlockedAccount[];
  /** A response settled whether the server supports blocking. */
  loaded: boolean;
  /** False only after the server answered GET /v1/cloud/blocks with an empty 404. */
  available: boolean;
  error: string | null;
};

type CloudBlocksStore = {
  snapshot: CloudBlocksSnapshot;
  listeners: Set<() => void>;
  refreshPromise: Promise<void> | null;
  refreshAgain: boolean;
};

const EMPTY_SNAPSHOT: CloudBlocksSnapshot = { blocks: [], loaded: false, available: true, error: null };
const stores = new Map<string, CloudBlocksStore>();

function storeFor(accountId: string): CloudBlocksStore {
  let store = stores.get(accountId);
  if (!store) {
    store = { snapshot: EMPTY_SNAPSHOT, listeners: new Set(), refreshPromise: null, refreshAgain: false };
    stores.set(accountId, store);
  }
  return store;
}

function publish(store: CloudBlocksStore, patch: Partial<CloudBlocksSnapshot>) {
  store.snapshot = { ...store.snapshot, ...patch };
  for (const listener of store.listeners) listener();
}

export function cloudBlocksSnapshot(accountId: string | null | undefined): CloudBlocksSnapshot {
  const id = accountId?.trim();
  return id ? stores.get(id)?.snapshot ?? EMPTY_SNAPSHOT : EMPTY_SNAPSHOT;
}

/** Reloads the list; concurrent calls share one request and queue one more. */
export function refreshCloudBlocks(accountId: string, deps: SafetyDeps = defaultSafetyDeps()): Promise<void> {
  const store = storeFor(accountId);
  if (store.refreshPromise) {
    store.refreshAgain = true;
    return store.refreshPromise;
  }
  store.refreshPromise = (async () => {
    try {
      const token = await safetySessionToken(deps, accountId);
      const blocks = await deps.client.listBlocks(token);
      publish(store, { blocks, loaded: true, available: true, error: null });
    } catch (error) {
      if (isMissingRoute(error)) {
        publish(store, { blocks: [], loaded: true, available: false, error: null });
      } else {
        publish(store, { error: error instanceof Error ? error.message : 'Could not load blocked people.' });
      }
    } finally {
      store.refreshPromise = null;
      if (store.refreshAgain) {
        store.refreshAgain = false;
        void refreshCloudBlocks(accountId, deps);
      }
    }
  })();
  return store.refreshPromise;
}

/** Applies a confirmed block before the next list refresh arrives. */
export function rememberBlockedAccount(accountId: string, block: CloudBlockedAccount) {
  const store = storeFor(accountId);
  publish(store, { blocks: [block, ...store.snapshot.blocks.filter((item) => item.accountId !== block.accountId)] });
}

/** Applies a confirmed unblock before the next list refresh arrives. */
export function forgetBlockedAccount(accountId: string, blockedAccountId: string) {
  const store = storeFor(accountId);
  publish(store, { blocks: store.snapshot.blocks.filter((item) => item.accountId !== blockedAccountId) });
}

export function __resetCloudBlocksForTests() {
  stores.clear();
}

export type UseCloudBlocksResult = CloudBlocksSnapshot & { refresh(this: void): Promise<void> };

export function useCloudBlocks(accountId: string | null | undefined, deps?: SafetyDeps): UseCloudBlocksResult {
  const id = accountId?.trim() || null;
  const subscribe = useCallback((listener: () => void) => {
    if (!id) return () => undefined;
    const store = storeFor(id);
    store.listeners.add(listener);
    return () => { store.listeners.delete(listener); };
  }, [id]);
  const getSnapshot = useCallback(() => cloudBlocksSnapshot(id), [id]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!id) return undefined;
    void refreshCloudBlocks(id, deps);
    const refreshDirectory = () => { void refreshCloudBlocks(id, deps); };
    if (typeof window !== 'undefined') window.addEventListener(CLOUD_DIRECTORY_SYNC_EVENT, refreshDirectory);
    return () => {
      if (typeof window !== 'undefined') window.removeEventListener(CLOUD_DIRECTORY_SYNC_EVENT, refreshDirectory);
    };
  }, [deps, id]);

  const refresh = useCallback(async () => {
    if (id) await refreshCloudBlocks(id, deps);
  }, [deps, id]);

  return useMemo(() => ({ ...snapshot, refresh }), [snapshot, refresh]);
}
