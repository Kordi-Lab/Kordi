import { shouldRefreshCloudContactsForWsSubject } from './cloudContactsEvents';
export { shouldRefreshCloudContactsForWsSubject } from './cloudContactsEvents';
import { isBrowserAppRuntime } from '@web/auth/browserAppRuntime';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { Contact, ContactRequest } from '@/kordi-app/types';

import {
  CloudAuthClient,
  cloudRealtimeWebSocketEnabled,
  cloudWebSocketUrl,
  defaultCloudAuthClient,
  type CloudAccount,
  type CloudContactRequest,
  type CloudContactSummary,
  type CloudMessage,
  type CloudPublicProfile,
} from './authClient';
import { cloudContactSummaryKey } from './cloudContactTypes';
import { cloudContactToContact, cloudRequestToContactRequest } from './cloudContactMapping';
import {
  applyAcceptedCloudContactRequest,
  applyCloudContactsRefreshSnapshot,
  cloudContactAcceptedSyncDetail,
  cloudContactAddedActorAccountId,
  cloudContactAddedOccurredAt,
  mergeCloudContactRequestSnapshot,
  mergeCloudContactSummarySnapshot,
  removeCloudContactRequestSnapshot,
  removeCloudContactSummarySnapshot,
  type CloudContactsSnapshot,
} from './cloudContactsSnapshot';
import { loadSession } from './session';
import { CLOUD_DIRECTORY_SYNC_EVENT } from './cloudDeviceEvents';
import {
  createCloudSupportTicket,
  getCloudSupportTicketBySubmissionId,
  type CloudSupportTicketInput,
  type CloudSupportTicketResult,
} from './supportClient';
import { removeCloudContact } from './contactProfileClient';

export {
  acceptedCloudContactPeerAccountId,
  applyAcceptedCloudContactRequest,
  applyCloudContactsRefreshSnapshot,
  cloudContactAcceptedSyncDetail,
  cloudContactAddedActorAccountId,
  mergeCloudContactRequestSnapshot,
  mergeCloudContactSummarySnapshot,
  removeCloudContactRequestSnapshot,
  removeCloudContactSummarySnapshot,
} from './cloudContactsSnapshot';
export {
  CLOUD_HOST_SENTINEL,
  cloudContactToContact,
  cloudRequestToContactRequest,
  isCloudContact,
  isPendingIncomingCloudContactRequest,
} from './cloudContactMapping';
export type { CloudContactsSnapshot } from './cloudContactsSnapshot';

export type UseCloudContactsResult = {
  contacts: Contact[];
  requests: ContactRequest[];
  loading: boolean;
  error: string | null;
  initialLoadSettled: boolean;
  refresh(): Promise<void>;
  sendRequest(peerAccountId: string, message?: string): Promise<void>;
  lookupProfile(accountId: string): Promise<CloudPublicProfile | null>;
  acceptRequest(requestId: string): Promise<void>;
  rejectRequest(requestId: string): Promise<void>;
  /** Deletes a contact in both directions; the row leaves at once and returns if the server refuses. */
  removeContact(this: void, peerAccountId: string): Promise<void>;
  submitSupportRequest: (input: CloudSupportTicketInput) => Promise<CloudSupportTicketResult>;
  getSupportRequest: (clientSubmissionId: string) => Promise<CloudSupportTicketResult | null>;
};

const REFRESH_INTERVAL_MS = 15_000;
const RECENTLY_ADDED_GRACE_MS = 60_000; // A contact added here outlives a server list that lacks it this long.
export const CLOUD_CONTACT_ACCEPTED_SYNC_EVENT = 'kordi.cloud.contact.accepted-sync';

export type CloudContactsStoreSnapshot = CloudContactsSnapshot & {
  loading: boolean;
  error: string | null;
  initialLoadSettled: boolean;
};

export type CloudContactsSnapshotState = {
  accountId: string | null;
  snapshot: CloudContactsStoreSnapshot;
};

type CloudContactsStore = {
  accountId: string;
  snapshot: CloudContactsStoreSnapshot;
  listeners: Set<() => void>;
  refreshPromise: Promise<void> | null;
  refreshAgain: boolean;
  mutationRevision: number;
  pollTimer: ReturnType<typeof window.setInterval> | null;
  ws: WebSocket | null;
  wsOpening: boolean;
  /** Contacts added here (summary key → expiry), kept until the server lists them. */
  recentlyAdded: Map<string, number>;
  /** People being removed here; refreshes skip them until the delete settles. */
  removing: Set<string>;
};

const EMPTY_CLOUD_CONTACTS_SNAPSHOT: CloudContactsStoreSnapshot = {
  contacts: [],
  requests: [],
  loading: false,
  error: null,
  initialLoadSettled: true,
};
const cloudContactStores = new Map<string, CloudContactsStore>();
/** Every mounted store, including the per-mount ones the browser app creates. */
const mountedCloudContactStores = new Set<CloudContactsStore>();

export function selectCloudContactsSnapshotForAccount(
  state: CloudContactsSnapshotState,
  accountId: string | null,
  fallback: CloudContactsStoreSnapshot,
): CloudContactsStoreSnapshot {
  return state.accountId === accountId ? state.snapshot : fallback;
}

function dispatchCloudContactAcceptedSync(request: CloudContactRequest, accountId: string, helloMessage?: CloudMessage | null): void {
  if (typeof window === 'undefined') return;
  const detail = cloudContactAcceptedSyncDetail(request, accountId, helloMessage);
  if (!detail) return;
  window.dispatchEvent(new CustomEvent(CLOUD_CONTACT_ACCEPTED_SYNC_EVENT, { detail }));
}

function cloudContactsStoreFor(accountId: string, fresh = false): CloudContactsStore {
  const existing = fresh ? null : cloudContactStores.get(accountId);
  if (existing) return existing;
  const store: CloudContactsStore = {
    accountId,
    snapshot: { ...EMPTY_CLOUD_CONTACTS_SNAPSHOT, initialLoadSettled: false },
    listeners: new Set(),
    refreshPromise: null,
    refreshAgain: false,
    mutationRevision: 0,
    pollTimer: null,
    ws: null,
    wsOpening: false,
    recentlyAdded: new Map(),
    removing: new Set(),
  };
  if (!fresh) cloudContactStores.set(accountId, store);
  return store;
}

export function shouldShowCloudContactsLoading(snapshot: Pick<CloudContactsStoreSnapshot, 'contacts' | 'requests' | 'initialLoadSettled'>): boolean {
  return !snapshot.initialLoadSettled && snapshot.contacts.length === 0 && snapshot.requests.length === 0;
}

function publishCloudContactsStore(store: CloudContactsStore, patch: Partial<CloudContactsStoreSnapshot>) {
  const next = { ...store.snapshot, ...patch };
  if (
    next.contacts === store.snapshot.contacts
    && next.requests === store.snapshot.requests
    && next.loading === store.snapshot.loading
    && next.error === store.snapshot.error
    && next.initialLoadSettled === store.snapshot.initialLoadSettled
  ) return;
  store.snapshot = next;
  for (const listener of store.listeners) listener();
}

function applyCloudContactsSnapshot(
  store: CloudContactsStore,
  updater: (snapshot: CloudContactsSnapshot) => CloudContactsSnapshot,
) {
  const next = updater({ contacts: store.snapshot.contacts, requests: store.snapshot.requests });
  store.mutationRevision += 1;
  publishCloudContactsStore(store, next);
}

function rememberRecentlyAdded(store: CloudContactsStore, contact: CloudContactSummary) {
  store.recentlyAdded.set(cloudContactSummaryKey(contact), Date.now() + RECENTLY_ADDED_GRACE_MS);
}

function recentlyAddedKeys(store: CloudContactsStore): Set<string> {
  const now = Date.now();
  for (const [key, expiresAt] of store.recentlyAdded) if (expiresAt <= now) store.recentlyAdded.delete(key);
  return new Set(store.recentlyAdded.keys());
}

/**
 * Takes a person out of every loaded contact list of `ownerAccountId` at once.
 * `commit` keeps them out; `rollback` puts the rows back after a failed delete.
 */
export function beginCloudContactRemoval(ownerAccountId: string, peerAccountId: string) {
  const peer = peerAccountId.trim();
  const touched: Array<{ store: CloudContactsStore; removed: CloudContactSummary[] }> = [];
  for (const store of new Set([...cloudContactStores.values(), ...mountedCloudContactStores])) {
    if (store.accountId !== ownerAccountId || !peer) continue;
    const removed = store.snapshot.contacts.filter((contact) => contact.contactKind !== 'system_agent' && contact.accountId === peer);
    for (const contact of removed) store.recentlyAdded.delete(cloudContactSummaryKey(contact));
    store.removing.add(peer);
    applyCloudContactsSnapshot(store, (current) => removeCloudContactSummarySnapshot(current, peer));
    touched.push({ store, removed });
  }
  const settle = (restore: boolean) => {
    for (const { store, removed } of touched.splice(0)) {
      store.removing.delete(peer);
      if (restore) applyCloudContactsSnapshot(store, (current) => removed.reduceRight(mergeCloudContactSummarySnapshot, current));
    }
  };
  return { commit: () => settle(false), rollback: () => settle(true) };
}

async function refreshCloudContactsStore(store: CloudContactsStore, client: CloudAuthClient): Promise<void> {
  if (store.refreshPromise) {
    store.refreshAgain = true;
    return store.refreshPromise;
  }
  store.refreshPromise = (async () => {
    const startedMutationRevision = store.mutationRevision;
    const session = await loadSession();
    if (!session?.token) {
      publishCloudContactsStore(store, { loading: false, initialLoadSettled: true });
      return;
    }
    publishCloudContactsStore(store, { loading: shouldShowCloudContactsLoading(store.snapshot), error: null });
    try {
      const [contacts, requests] = await Promise.all([
        client.listContacts(session.token),
        client.listContactRequests(session.token),
      ]);
      const listed = contacts.filter((contact) => contact.contactKind === 'system_agent' || !store.removing.has(contact.accountId));
      const next = applyCloudContactsRefreshSnapshot(
        { contacts: store.snapshot.contacts, requests: store.snapshot.requests },
        { contacts: listed, requests },
        { startedMutationRevision, currentMutationRevision: store.mutationRevision },
        recentlyAddedKeys(store),
      );
      for (const contact of listed) store.recentlyAdded.delete(cloudContactSummaryKey(contact));
      publishCloudContactsStore(store, { ...next, loading: false, error: null, initialLoadSettled: true });
    } catch (err) {
      publishCloudContactsStore(store, {
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to load cloud contacts',
        initialLoadSettled: true,
      });
    } finally {
      store.refreshPromise = null;
      if (store.refreshAgain) {
        store.refreshAgain = false;
        void refreshCloudContactsStore(store, client);
      }
    }
  })();
  return store.refreshPromise;
}

function ensureCloudContactsWebSocket(store: CloudContactsStore, client: CloudAuthClient) {
  if (store.ws || store.wsOpening || typeof WebSocket === 'undefined' || !cloudRealtimeWebSocketEnabled()) return;
  store.wsOpening = true;
  void loadSession()
    .then((session) => {
      if (!session?.token || store.ws) return;
      const ws = new WebSocket(cloudWebSocketUrl(session.token));
      store.ws = ws;
      ws.onmessage = (event) => {
        try {
          const frame = JSON.parse(typeof event.data === 'string' ? event.data : '');
          const subject = typeof frame?.subject === 'string' ? frame.subject : '';
          const addedPeerId = subject.startsWith('kordi.events.contact.added.')
            ? cloudContactAddedActorAccountId(frame?.payload, store.accountId)
            : null;
          if (addedPeerId) {
            void client.getProfile(session.token, addedPeerId)
              .then((profile) => {
                const added: CloudContactSummary = {
                  accountId: profile.accountId,
                  displayName: profile.displayName,
                  avatarUrl: profile.avatarUrl,
                  nodeId: profile.nodeId,
                  createdAt: cloudContactAddedOccurredAt(frame?.payload) || new Date().toISOString(),
                };
                rememberRecentlyAdded(store, added);
                applyCloudContactsSnapshot(store, (current) => mergeCloudContactSummarySnapshot(current, added));
              })
              .catch(() => undefined)
              .finally(() => void refreshCloudContactsStore(store, client));
            return;
          }
          if (shouldRefreshCloudContactsForWsSubject(subject)) {
            void refreshCloudContactsStore(store, client);
          }
        } catch (error) {
          console.warn('[cloud-contacts-ws] frame parse failed', error);
        }
      };
      ws.onclose = () => {
        if (store.ws === ws) store.ws = null;
      };
      ws.onerror = () => {
        ws.close();
      };
    })
    .finally(() => {
      store.wsOpening = false;
    });
}

function startCloudContactsStore(store: CloudContactsStore, client: CloudAuthClient) {
  void refreshCloudContactsStore(store, client);
  ensureCloudContactsWebSocket(store, client);
  if (!store.pollTimer && typeof window !== 'undefined') {
    store.pollTimer = window.setInterval(() => void refreshCloudContactsStore(store, client), REFRESH_INTERVAL_MS);
  }
}

export function useCloudContacts(account: CloudAccount | null): UseCloudContactsResult {
  const client = useMemo<CloudAuthClient>(() => defaultCloudAuthClient(), []);
  const accountId = account?.accountId;
  const store = useMemo(() => accountId ? cloudContactsStoreFor(accountId, isBrowserAppRuntime()) : null, [accountId]);
  const [snapshotState, setSnapshotState] = useState<CloudContactsSnapshotState>(() => ({
    accountId: store?.accountId ?? null,
    snapshot: store?.snapshot ?? EMPTY_CLOUD_CONTACTS_SNAPSHOT,
  }));
  const snapshot = selectCloudContactsSnapshotForAccount(
    snapshotState,
    store?.accountId ?? null,
    store?.snapshot ?? EMPTY_CLOUD_CONTACTS_SNAPSHOT,
  );

  useEffect(() => {
    if (!store || !account) {
      setSnapshotState({ accountId: null, snapshot: EMPTY_CLOUD_CONTACTS_SNAPSHOT });
      return;
    }
    const publishSnapshot = () => setSnapshotState({
      accountId: store.accountId,
      snapshot: store.snapshot,
    });
    publishSnapshot();
    const listener = () => publishSnapshot();
    const refreshDirectory = () => { void refreshCloudContactsStore(store, client); };
    store.listeners.add(listener);
    mountedCloudContactStores.add(store);
    startCloudContactsStore(store, client);
    if (typeof window !== 'undefined') window.addEventListener(CLOUD_DIRECTORY_SYNC_EVENT, refreshDirectory);
    return () => {
      store.listeners.delete(listener);
      if (typeof window !== 'undefined') window.removeEventListener(CLOUD_DIRECTORY_SYNC_EVENT, refreshDirectory);
      if (store.listeners.size === 0) {
        mountedCloudContactStores.delete(store);
        if (store.pollTimer && typeof window !== 'undefined') window.clearInterval(store.pollTimer);
        store.pollTimer = null;
        store.ws?.close();
        store.ws = null;
      }
    };
  }, [account, client, store]);

  const fetchData = useCallback(async () => {
    if (!store) return;
    await refreshCloudContactsStore(store, client);
  }, [client, store]);

  const sendRequest = useCallback(
    async (peerAccountId: string, message?: string) => {
      if (!store) throw new Error('Not signed in.');
      const session = await loadSession();
      if (!session?.token) throw new Error('Not signed in.');
      const request = await client.sendContactRequest(session.token, peerAccountId, message);
      applyCloudContactsSnapshot(store, (current) => mergeCloudContactRequestSnapshot(current, request));
      void refreshCloudContactsStore(store, client);
    },
    [client, store],
  );

  const lookupProfile = useCallback(
    async (accountId: string) => {
      if (!store) throw new Error('Not signed in.');
      const session = await loadSession();
      if (!session?.token) throw new Error('Not signed in.');
      const trimmed = accountId.trim();
      if (!trimmed) return null;
      return client.getProfile(session.token, trimmed);
    },
    [client, store],
  );

  const acceptRequest = useCallback(
    async (requestId: string) => {
      if (!store) throw new Error('Not signed in.');
      const session = await loadSession();
      if (!session?.token) throw new Error('Not signed in.');
      try {
        const result = await client.acceptContactRequest(session.token, requestId);
        if (result.request.counterpart) rememberRecentlyAdded(store, result.request.counterpart);
        applyCloudContactsSnapshot(store, (current) => applyAcceptedCloudContactRequest(current, result.request));
        dispatchCloudContactAcceptedSync(result.request, store.accountId, result.helloMessage);
      } catch (error) {
        void refreshCloudContactsStore(store, client);
        throw error;
      }
    },
    [client, store],
  );

  const rejectRequest = useCallback(
    async (requestId: string) => {
      if (!store) throw new Error('Not signed in.');
      const session = await loadSession();
      if (!session?.token) throw new Error('Not signed in.');
      applyCloudContactsSnapshot(store, (current) => removeCloudContactRequestSnapshot(current, requestId));
      try {
        await client.rejectContactRequest(session.token, requestId);
        void refreshCloudContactsStore(store, client);
      } catch (error) {
        void refreshCloudContactsStore(store, client);
        throw error;
      }
    },
    [client, store],
  );

  const removeContact = useCallback(
    async (peerAccountId: string) => {
      if (!store) throw new Error('Not signed in.');
      const removal = beginCloudContactRemoval(store.accountId, peerAccountId);
      try {
        await removeCloudContact(peerAccountId, { request: (path, init, fallback) => client.request(path, init, fallback) });
        removal.commit();
      } catch (error) {
        removal.rollback();
        throw error;
      } finally {
        void refreshCloudContactsStore(store, client);
      }
    },
    [client, store],
  );

  const submitSupportRequest = useCallback(
    async (input: CloudSupportTicketInput) => {
      if (!store) throw new Error('Not signed in.');
      const session = await loadSession();
      if (!session?.token) throw new Error('Not signed in.');
      return createCloudSupportTicket(client, session.token, input);
    },
    [client, store],
  );

  const getSupportRequest = useCallback(
    async (clientSubmissionId: string) => {
      if (!store) throw new Error('Not signed in.');
      const session = await loadSession();
      if (!session?.token) throw new Error('Not signed in.');
      return getCloudSupportTicketBySubmissionId(
        client,
        session.token,
        clientSubmissionId,
      );
    },
    [client, store],
  );

  const mappedContacts = useMemo<Contact[]>(
    () => snapshot.contacts.map((row) => cloudContactToContact(row)),
    [snapshot.contacts],
  );
  const mappedRequests = useMemo<ContactRequest[]>(
    () => snapshot.requests.map((row) => cloudRequestToContactRequest(row)),
    [snapshot.requests],
  );

  return {
    contacts: mappedContacts,
    requests: mappedRequests,
    loading: snapshot.loading,
    error: snapshot.error,
    initialLoadSettled: snapshot.initialLoadSettled,
    refresh: fetchData,
    sendRequest,
    lookupProfile,
    acceptRequest,
    rejectRequest,
    removeContact,
    submitSupportRequest,
    getSupportRequest,
  };
}

/** Test seam: a registered store holding `contacts`, as a refresh leaves it. */
export function __cloudContactsStoreForTests(accountId: string, contacts: CloudContactSummary[]) {
  const store = cloudContactsStoreFor(accountId);
  publishCloudContactsStore(store, { contacts, initialLoadSettled: true });
  return { store, clear: () => cloudContactStores.delete(accountId) };
}
