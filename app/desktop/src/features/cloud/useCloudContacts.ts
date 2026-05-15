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
  type CloudMessage,
} from './authClient';
import { cloudAvatarImageUrl, cloudAvatarSeedForAccount } from './avatar';
import { loadSession } from './session';

export type UseCloudContactsResult = {
  contacts: Contact[];
  requests: ContactRequest[];
  loading: boolean;
  error: string | null;
  initialLoadSettled: boolean;
  refresh(): Promise<void>;
  sendRequest(peerAccountId: string, message?: string): Promise<void>;
  acceptRequest(requestId: string): Promise<void>;
  rejectRequest(requestId: string): Promise<void>;
};

const REFRESH_INTERVAL_MS = 15_000;
export const CLOUD_CONTACT_ACCEPTED_SYNC_EVENT = 'kordi.cloud.contact.accepted-sync';

export type CloudContactsSnapshot = {
  contacts: CloudContactSummary[];
  requests: CloudContactRequest[];
};

type CloudContactsStoreSnapshot = CloudContactsSnapshot & {
  loading: boolean;
  error: string | null;
  initialLoadSettled: boolean;
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
};

const EMPTY_CLOUD_CONTACTS_SNAPSHOT: CloudContactsStoreSnapshot = {
  contacts: [],
  requests: [],
  loading: false,
  error: null,
  initialLoadSettled: true,
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

export function mergeCloudContactSummarySnapshot(
  snapshot: CloudContactsSnapshot,
  contact: CloudContactSummary,
): CloudContactsSnapshot {
  const existing = snapshot.contacts.find((item) => item.accountId === contact.accountId);
  const contacts = existing
    ? snapshot.contacts.map((item) => (item.accountId === contact.accountId ? { ...item, ...contact } : item))
    : [contact, ...snapshot.contacts];
  return { ...snapshot, contacts };
}

export function applyAcceptedCloudContactRequest(
  snapshot: CloudContactsSnapshot,
  request: CloudContactRequest,
): CloudContactsSnapshot {
  const nextRequests = snapshot.requests.filter((item) => item.requestId !== request.requestId);
  const counterpart = request.counterpart;
  if (!counterpart) return { ...snapshot, requests: nextRequests };
  const acceptedContact: CloudContactSummary = {
    ...counterpart,
    createdAt: counterpart.createdAt || request.decidedAt || new Date().toISOString(),
  };
  return mergeCloudContactSummarySnapshot({ ...snapshot, requests: nextRequests }, acceptedContact);
}

export function applyCloudContactsRefreshSnapshot(
  current: CloudContactsSnapshot,
  refreshed: CloudContactsSnapshot,
  revisions: { startedMutationRevision: number; currentMutationRevision: number },
): CloudContactsSnapshot {
  if (revisions.startedMutationRevision !== revisions.currentMutationRevision) return current;

  const contactsByAccountId = new Map<string, CloudContactSummary>();
  for (const contact of current.contacts) contactsByAccountId.set(contact.accountId, contact);
  for (const contact of refreshed.contacts) contactsByAccountId.set(contact.accountId, contact);
  const contacts = [...contactsByAccountId.values()];
  const acceptedAccountIds = new Set(contacts.map((contact) => contact.accountId));
  const requests = refreshed.requests.filter((request) => {
    const counterpartId = request.counterpart?.accountId || (request.direction === 'incoming' ? request.fromAccountId : request.toAccountId);
    return !acceptedAccountIds.has(counterpartId);
  });

  return { contacts, requests };
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function cloudContactAddedActorAccountId(payload: unknown, accountId: string): string | null {
  const record = objectRecord(payload);
  const actorId = cleanText(record?.actor_account_id);
  const peerId = cleanText(record?.peer_account_id);
  const selfId = accountId.trim();
  if (!actorId || !peerId || !selfId || peerId !== selfId || actorId === selfId) return null;
  return actorId;
}

export function acceptedCloudContactPeerAccountId(request: CloudContactRequest, accountId: string): string | null {
  const selfId = accountId.trim();
  if (request.status !== 'accepted' || !selfId) return null;
  if (request.fromAccountId === selfId) return request.toAccountId;
  if (request.toAccountId === selfId) return request.fromAccountId;
  return null;
}

export function cloudContactAcceptedSyncDetail(
  request: CloudContactRequest,
  accountId: string,
  helloMessage?: CloudMessage | null,
): { requestId: string; peerAccountId: string; message?: CloudMessage } | null {
  const peerAccountId = acceptedCloudContactPeerAccountId(request, accountId);
  if (!peerAccountId) return null;
  return {
    requestId: request.requestId,
    peerAccountId,
    ...(helloMessage ? { message: helloMessage } : {}),
  };
}

function dispatchCloudContactAcceptedSync(request: CloudContactRequest, accountId: string, helloMessage?: CloudMessage | null): void {
  if (typeof window === 'undefined') return;
  const detail = cloudContactAcceptedSyncDetail(request, accountId, helloMessage);
  if (!detail) return;
  window.dispatchEvent(new CustomEvent(CLOUD_CONTACT_ACCEPTED_SYNC_EVENT, { detail }));
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
    snapshot: { ...EMPTY_CLOUD_CONTACTS_SNAPSHOT, initialLoadSettled: false },
    listeners: new Set(),
    refreshPromise: null,
    refreshAgain: false,
    mutationRevision: 0,
    pollTimer: null,
    ws: null,
    wsOpening: false,
  };
  cloudContactStores.set(accountId, store);
  return store;
}

export function shouldShowCloudContactsLoading(snapshot: Pick<CloudContactsStoreSnapshot, 'contacts' | 'requests' | 'initialLoadSettled'>): boolean {
  return !snapshot.initialLoadSettled && snapshot.contacts.length === 0 && snapshot.requests.length === 0;
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
  store.mutationRevision += 1;
  publishCloudContactsStore(store, next);
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
      const next = applyCloudContactsRefreshSnapshot(
        { contacts: store.snapshot.contacts, requests: store.snapshot.requests },
        { contacts, requests },
        { startedMutationRevision, currentMutationRevision: store.mutationRevision },
      );
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
          const subject = typeof frame?.subject === 'string' ? frame.subject : '';
          const addedPeerId = subject.startsWith('kordi.events.contact.added.')
            ? cloudContactAddedActorAccountId(frame?.payload, store.accountId)
            : null;
          if (addedPeerId) {
            void client.getProfile(session.token, addedPeerId)
              .then((profile) => {
                applyCloudContactsSnapshot(store, (current) => mergeCloudContactSummarySnapshot(current, {
                  accountId: profile.accountId,
                  displayName: profile.displayName,
                  avatarUrl: profile.avatarUrl,
                  nodeId: profile.nodeId,
                  createdAt: cleanText(objectRecord(frame?.payload)?.occurred_at) || new Date().toISOString(),
                }));
              })
              .catch(() => undefined)
              .finally(() => void refreshCloudContactsStore(store, client));
            return;
          }
          if (shouldRefreshCloudContactsForWsSubject(subject)) {
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
      try {
        const result = await client.acceptContactRequest(session.token, requestId);
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
