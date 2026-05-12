// useCloudContacts: load + mutate the cloud contact graph for the
// signed-in account, exposing the data in the shapes the existing
// ContactsPage / ChatCreateDialog already consume (Contact +
// ContactRequest). This keeps the UI plumbing untouched — cloud rows
// just look like another data source in the same shape.

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { Contact, ContactRequest } from '@/kordi-app/types';

import {
  CloudAuthClient,
  cloudWebSocketUrl,
  defaultCloudAuthClient,
  type CloudAccount,
  type CloudContactRequest,
  type CloudContactSummary,
} from './authClient';
import { cloudAvatarImageUrl, cloudAvatarSeedForAccount } from './avatar';
import { loadSession } from './session';

export type UseCloudContactsResult = {
  contacts: Contact[];
  requests: ContactRequest[];
  loading: boolean;
  error: string | null;
  refresh(): Promise<void>;
  sendRequest(peerAccountId: string, message?: string): Promise<void>;
  acceptRequest(requestId: string): Promise<void>;
  rejectRequest(requestId: string): Promise<void>;
};

const REFRESH_INTERVAL_MS = 15_000;

export type CloudContactsSnapshot = {
  contacts: CloudContactSummary[];
  requests: CloudContactRequest[];
};

type CloudContactsStoreSnapshot = CloudContactsSnapshot & {
  loading: boolean;
  error: string | null;
};

type CloudContactsStore = {
  accountId: string;
  snapshot: CloudContactsStoreSnapshot;
  listeners: Set<() => void>;
  refreshPromise: Promise<void> | null;
  refreshAgain: boolean;
  pollTimer: ReturnType<typeof window.setInterval> | null;
  ws: WebSocket | null;
  wsOpening: boolean;
};

const EMPTY_CLOUD_CONTACTS_SNAPSHOT: CloudContactsStoreSnapshot = {
  contacts: [],
  requests: [],
  loading: false,
  error: null,
};
const cloudContactStores = new Map<string, CloudContactsStore>();

export function mergeCloudContactRequestSnapshot(
  snapshot: CloudContactsSnapshot,
  request: CloudContactRequest,
): CloudContactsSnapshot {
  const nextRequests = snapshot.requests.filter((item) => item.requestId !== request.requestId);
  if (request.status === 'pending') nextRequests.unshift(request);
  return { ...snapshot, requests: nextRequests };
}

export function applyAcceptedCloudContactRequest(
  snapshot: CloudContactsSnapshot,
  request: CloudContactRequest,
): CloudContactsSnapshot {
  const nextRequests = snapshot.requests.filter((item) => item.requestId !== request.requestId);
  const counterpart = request.counterpart;
  if (!counterpart) return { ...snapshot, requests: nextRequests };
  const existing = snapshot.contacts.find((contact) => contact.accountId === counterpart.accountId);
  const acceptedContact: CloudContactSummary = {
    ...counterpart,
    createdAt: counterpart.createdAt || request.decidedAt || new Date().toISOString(),
  };
  const contacts = existing
    ? snapshot.contacts.map((contact) => (contact.accountId === counterpart.accountId ? { ...contact, ...acceptedContact } : contact))
    : [acceptedContact, ...snapshot.contacts];
  return { contacts, requests: nextRequests };
}

export function removeCloudContactRequestSnapshot(
  snapshot: CloudContactsSnapshot,
  requestId: string,
): CloudContactsSnapshot {
  return {
    ...snapshot,
    requests: snapshot.requests.filter((item) => item.requestId !== requestId),
  };
}

export function shouldRefreshCloudContactsForWsSubject(subject: string | undefined | null): boolean {
  return Boolean(subject?.startsWith('kordi.events.contact.request.') || subject?.startsWith('kordi.events.contact.added.'));
}

function cloudContactsStoreFor(accountId: string): CloudContactsStore {
  const existing = cloudContactStores.get(accountId);
  if (existing) return existing;
  const store: CloudContactsStore = {
    accountId,
    snapshot: EMPTY_CLOUD_CONTACTS_SNAPSHOT,
    listeners: new Set(),
    refreshPromise: null,
    refreshAgain: false,
    pollTimer: null,
    ws: null,
    wsOpening: false,
  };
  cloudContactStores.set(accountId, store);
  return store;
}

function publishCloudContactsStore(store: CloudContactsStore, patch: Partial<CloudContactsStoreSnapshot>) {
  store.snapshot = { ...store.snapshot, ...patch };
  for (const listener of store.listeners) listener();
}

function applyCloudContactsSnapshot(
  store: CloudContactsStore,
  updater: (snapshot: CloudContactsSnapshot) => CloudContactsSnapshot,
) {
  const next = updater({ contacts: store.snapshot.contacts, requests: store.snapshot.requests });
  publishCloudContactsStore(store, next);
}

async function refreshCloudContactsStore(store: CloudContactsStore, client: CloudAuthClient): Promise<void> {
  if (store.refreshPromise) {
    store.refreshAgain = true;
    return store.refreshPromise;
  }
  store.refreshPromise = (async () => {
    const session = await loadSession();
    if (!session?.token) return;
    publishCloudContactsStore(store, { loading: true, error: null });
    try {
      const [contacts, requests] = await Promise.all([
        client.listContacts(session.token),
        client.listContactRequests(session.token),
      ]);
      publishCloudContactsStore(store, { contacts, requests, loading: false, error: null });
    } catch (err) {
      publishCloudContactsStore(store, {
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to load cloud contacts',
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
  if (store.ws || store.wsOpening || typeof WebSocket === 'undefined') return;
  store.wsOpening = true;
  void loadSession()
    .then((session) => {
      if (!session?.token || store.ws) return;
      const ws = new WebSocket(cloudWebSocketUrl(session.token));
      store.ws = ws;
      ws.onmessage = (event) => {
        try {
          const frame = JSON.parse(typeof event.data === 'string' ? event.data : '');
          if (shouldRefreshCloudContactsForWsSubject(frame?.subject)) {
            void refreshCloudContactsStore(store, client);
          }
        } catch (error) {
          // eslint-disable-next-line no-console
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
  const store = account ? cloudContactsStoreFor(account.accountId) : null;
  const [snapshot, setSnapshot] = useState<CloudContactsStoreSnapshot>(() => store?.snapshot ?? EMPTY_CLOUD_CONTACTS_SNAPSHOT);

  useEffect(() => {
    if (!store || !account) {
      setSnapshot(EMPTY_CLOUD_CONTACTS_SNAPSHOT);
      return;
    }
    setSnapshot(store.snapshot);
    const listener = () => setSnapshot(store.snapshot);
    store.listeners.add(listener);
    startCloudContactsStore(store, client);
    return () => {
      store.listeners.delete(listener);
      if (store.listeners.size === 0) {
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

  const acceptRequest = useCallback(
    async (requestId: string) => {
      if (!store) throw new Error('Not signed in.');
      const session = await loadSession();
      if (!session?.token) throw new Error('Not signed in.');
      applyCloudContactsSnapshot(store, (current) => removeCloudContactRequestSnapshot(current, requestId));
      try {
        const request = await client.acceptContactRequest(session.token, requestId);
        applyCloudContactsSnapshot(store, (current) => applyAcceptedCloudContactRequest(current, request));
        void refreshCloudContactsStore(store, client);
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
    refresh: fetchData,
    sendRequest,
    acceptRequest,
    rejectRequest,
  };
}

export const CLOUD_HOST_SENTINEL = 'cloud';

export function isCloudContact(contact: Contact): boolean {
  return contact.id.startsWith('cloud:')
    || contact.bridgeHostId === CLOUD_HOST_SENTINEL
    || contact.discoverableOn.includes(CLOUD_HOST_SENTINEL);
}

export function shouldOpenCloudPeerChat(_edition: 'local' | 'cloud', _contact: Contact): boolean {
  // Deprecated: cloud contacts now route through the existing Bridge-shaped
  // chat/session UI instead of the old standalone CloudPeerChatPanel.
  return false;
}

export function cloudContactToContact(row: CloudContactSummary): Contact {
  const name = row.displayName ?? row.accountId;
  return {
    id: `cloud:${row.accountId}`,
    name,
    initials: deriveInitials(name),
    classType: 'other-users',
    entityType: 'user',
    subtitle: row.accountId,
    bridges: [CLOUD_HOST_SENTINEL],
    status: 'online',
    discoverableOn: [CLOUD_HOST_SENTINEL],
    detail: row.accountId,
    owner: name,
    bridgeHostId: CLOUD_HOST_SENTINEL,
    bridgePeerNodeId: row.accountId,
    bridgePeerRuntime: 'person',
    bridgeHumanId: row.accountId,
    bridgeContactStatus: 'accepted',
    bridgeContactRequestDirection: 'outgoing',
    avatarSeed: cloudAvatarSeedForAccount(row.accountId, row.avatarUrl),
    profileImageUrl: cloudAvatarImageUrl(row.avatarUrl),
  };
}

export function isPendingIncomingCloudContactRequest(request: Pick<ContactRequest, 'direction' | 'status'>): boolean {
  return request.direction === 'incoming' && request.status === 'pending';
}

export function cloudRequestToContactRequest(row: CloudContactRequest): ContactRequest {
  const counterpartName = row.counterpart?.displayName ?? row.counterpart?.accountId ?? (
    row.direction === 'incoming' ? row.fromAccountId : row.toAccountId
  );
  const counterpartId = row.direction === 'incoming' ? row.fromAccountId : row.toAccountId;
  const title = row.direction === 'incoming'
    ? `${counterpartName} wants to connect`
    : `Request sent to ${counterpartName}`;
  return {
    id: `cloud:${row.requestId}`,
    initials: deriveInitials(counterpartName),
    title,
    detail: row.message ?? counterpartId,
    time: row.createdAt,
    profileImageUrl: cloudAvatarImageUrl(row.counterpart?.avatarUrl),
    avatarSeed: cloudAvatarSeedForAccount(counterpartId, row.counterpart?.avatarUrl),
    source: 'bridge',
    bridgeHostId: CLOUD_HOST_SENTINEL,
    bridgeRequestId: row.requestId,
    requesterNodeId: row.fromAccountId,
    targetNodeId: row.toAccountId,
    status: row.status,
    direction: row.direction,
  };
}

function deriveInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return trimmed.slice(0, 2).toUpperCase();
}
