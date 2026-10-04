// Per-account store for the private block list. It is separate from the
// contacts store so a server without blocking (an empty 404) never disturbs
// contact refreshes, and it doubles as the feature-availability signal for
// block, report, leave, withdraw, and remove actions.

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

import { defaultCloudAuthClient, type CloudAccount, type CloudAuthClient } from '@/features/cloud/authClient';
import { CLOUD_DIRECTORY_SYNC_EVENT } from '@/features/cloud/cloudDeviceEvents';
import { loadSession } from '@/features/cloud/session';

import { isMissingRoute, listBlockedAccounts } from './safetyClient';
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
  accountId: string;
  snapshot: CloudBlocksSnapshot;
  listeners: Set<() => void>;
  refreshPromise: Promise<void> | null;
  refreshAgain: boolean;
};

const INITIAL_SNAPSHOT: CloudBlocksSnapshot = { blocks: [], loaded: false, available: true, error: null };
const EMPTY_SNAPSHOT: CloudBlocksSnapshot = INITIAL_SNAPSHOT;
const stores = new Map<string, CloudBlocksStore>();
let activeAccountId: string | null = null;
let sharedClient: CloudAuthClient | null = null;

function defaultClient(): CloudAuthClient {
  sharedClient ??= defaultCloudAuthClient();
  return sharedClient;
}

function storeFor(accountId: string): CloudBlocksStore {
  const existing = stores.get(accountId);
  if (existing) return existing;
  const store: CloudBlocksStore = {
    accountId,
    snapshot: INITIAL_SNAPSHOT,
    listeners: new Set(),
    refreshPromise: null,
    refreshAgain: false,
  };
  stores.set(accountId, store);
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

/** Whether the signed-in server supports block, report, leave, withdraw, and remove. */
export function safetyFeaturesAvailableFor(accountId: string | null | undefined): boolean {
  const snapshot = cloudBlocksSnapshot(accountId);
  return snapshot.loaded && snapshot.available;
}

/**
 * Canonical `human:<account>` identities the account blocked, for callers
 * outside React. Without an account it uses the most recently active one.
 */
export function currentBlockedIdentityIds(accountId: string | null = activeAccountId): Set<string> {
  return new Set(cloudBlocksSnapshot(accountId).blocks.map((block) => `human:${block.accountId}`));
}

export function refreshCloudBlocks(
  accountId: string,
  client: CloudAuthClient = defaultClient(),
): Promise<void> {
  const store = storeFor(accountId);
  if (store.refreshPromise) {
    store.refreshAgain = true;
    return store.refreshPromise;
  }
  store.refreshPromise = (async () => {
    try {
      const session = await loadSession();
      if (!session?.token || session.accountId !== accountId) return;
      const blocks = await listBlockedAccounts(client, session.token);
      publish(store, { blocks, loaded: true, available: true, error: null });
    } catch (error) {
      if (isMissingRoute(error)) {
        publish(store, { blocks: [], loaded: true, available: false, error: null });
      } else {
        publish(store, { error: error instanceof Error ? error.message : 'Could not load blocked accounts.' });
      }
    } finally {
      store.refreshPromise = null;
      if (store.refreshAgain) {
        store.refreshAgain = false;
        void refreshCloudBlocks(accountId, client);
      }
    }
  })();
  return store.refreshPromise;
}

/** Applies a confirmed block before the next list refresh arrives. */
export function rememberBlockedAccount(accountId: string, block: CloudBlockedAccount) {
  const store = storeFor(accountId);
  const blocks = [block, ...store.snapshot.blocks.filter((item) => item.accountId !== block.accountId)];
  publish(store, { blocks });
}

/** Applies a confirmed unblock before the next list refresh arrives. */
export function forgetBlockedAccount(accountId: string, blockedAccountId: string) {
  const store = storeFor(accountId);
  publish(store, { blocks: store.snapshot.blocks.filter((item) => item.accountId !== blockedAccountId) });
}

export function __resetCloudBlocksForTests() {
  stores.clear();
  activeAccountId = null;
  sharedClient = null;
}

export type UseCloudBlocksResult = CloudBlocksSnapshot & {
  refresh(): Promise<void>;
};

export function useCloudBlocks(account: Pick<CloudAccount, 'accountId'> | null): UseCloudBlocksResult {
  const accountId = account?.accountId?.trim() || null;
  const subscribe = useCallback((listener: () => void) => {
    if (!accountId) return () => undefined;
    const store = storeFor(accountId);
    store.listeners.add(listener);
    return () => { store.listeners.delete(listener); };
  }, [accountId]);
  const getSnapshot = useCallback(() => cloudBlocksSnapshot(accountId), [accountId]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!accountId) return undefined;
    activeAccountId = accountId;
    void refreshCloudBlocks(accountId);
    const refreshDirectory = () => { void refreshCloudBlocks(accountId); };
    if (typeof window !== 'undefined') window.addEventListener(CLOUD_DIRECTORY_SYNC_EVENT, refreshDirectory);
    return () => {
      if (typeof window !== 'undefined') window.removeEventListener(CLOUD_DIRECTORY_SYNC_EVENT, refreshDirectory);
    };
  }, [accountId]);

  const refresh = useCallback(async () => {
    if (accountId) await refreshCloudBlocks(accountId);
  }, [accountId]);

  return useMemo(() => ({ ...snapshot, refresh }), [snapshot, refresh]);
}
