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
import {
  CLOUD_HOST_SENTINEL,
  cloudContactInitials,
  cloudContactToContact,
} from './cloudContactMapping';
import { cloudAvatarImageUrl, cloudAvatarSeedForAccount } from './avatar';
import {
  applyCloudContactsRefreshSnapshot,
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
import { formatKordiHandle } from './kordiId';

export { applyCloudContactsRefreshSnapshot } from './cloudContactsSnapshot';
export { CLOUD_HOST_SENTINEL, cloudContactToContact, isCloudContact } from './cloudContactMapping';
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
  submitSupportRequest: (input: CloudSupportTicketInput) => Promise<CloudSupportTicketResult>;
  getSupportRequest: (clientSubmissionId: string) => Promise<CloudSupportTicketResult | null>;
};

const REFRESH_INTERVAL_MS = 15_000;
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
};

const EMPTY_CLOUD_CONTACTS_SNAPSHOT: CloudContactsStoreSnapshot = {
  contacts: [],
  requests: [],
  loading: false,
  error: null,
  initialLoadSettled: true,
};
const cloudContactStores = new Map<string, CloudContactsStore>();

export function selectCloudContactsSnapshotForAccount(
  state: CloudContactsSnapshotState,
  accountId: string | null,
  fallback: CloudContactsStoreSnapshot,
): CloudContactsStoreSnapshot {
  return state.accountId === accountId ? state.snapshot : fallback;
}

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
  const contactKey = cloudContactSummaryKey(contact);
  const existing = snapshot.contacts.find((item) => cloudContactSummaryKey(item) === contactKey);
  const contacts = existing
    ? snapshot.contacts.map((item) => (cloudContactSummaryKey(item) === contactKey ? { ...item, ...contact } : item))
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
  return Boolean(
    subject?.startsWith('kordi.events.contact.request.')
      || subject?.startsWith('kordi.events.contact.added.')
      || subject?.startsWith('kordi.events.account.profile.updated.'),
  );
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
    startCloudContactsStore(store, client);
    if (typeof window !== 'undefined') window.addEventListener(CLOUD_DIRECTORY_SYNC_EVENT, refreshDirectory);
    return () => {
      store.listeners.delete(listener);
      if (typeof window !== 'undefined') window.removeEventListener(CLOUD_DIRECTORY_SYNC_EVENT, refreshDirectory);
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
    submitSupportRequest,
    getSupportRequest,
  };
}

export function isPendingIncomingCloudContactRequest(request: Pick<ContactRequest, 'direction' | 'status'>): boolean {
  return request.direction === 'incoming' && request.status === 'pending';
}

export function cloudRequestToContactRequest(row: CloudContactRequest): ContactRequest {
  const counterpartKordiHandle = formatKordiHandle(row.counterpart?.kordiId);
  const counterpartName = row.counterpart?.displayName?.trim() || counterpartKordiHandle || 'Kordi user';
  const counterpartId = row.direction === 'incoming' ? row.fromAccountId : row.toAccountId;
  const title = row.direction === 'incoming'
    ? `${counterpartName} wants to connect`
    : `Request sent to ${counterpartName}`;
  return {
    id: `cloud:${row.requestId}`,
    initials: cloudContactInitials(counterpartName),
    title,
    detail: row.message?.trim() || counterpartKordiHandle || 'Kordi ID unavailable',
    time: row.createdAt,
    profileImageUrl: cloudAvatarImageUrl(row.counterpart?.avatarUrl),
    avatarSeed: cloudAvatarSeedForAccount(counterpartId, row.counterpart?.avatarUrl),
    avatarName: counterpartName,
    source: 'collaboration',
    sourceHostId: CLOUD_HOST_SENTINEL,
    sourceRequestId: row.requestId,
    requesterNodeId: row.fromAccountId,
    targetNodeId: row.toAccountId,
    status: row.status,
    direction: row.direction,
  };
}
