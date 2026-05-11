// useCloudContacts: load + mutate the cloud contact graph for the
// signed-in account, exposing the data in the shapes the existing
// ContactsPage / ChatCreateDialog already consume (Contact +
// ContactRequest). This keeps the UI plumbing untouched — cloud rows
// just look like another data source in the same shape.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Contact, ContactRequest } from '@/kordi-app/types';

import {
  CloudAuthClient,
  defaultCloudAuthClient,
  type CloudAccount,
  type CloudContactRequest,
  type CloudContactSummary,
} from './authClient';
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

export function useCloudContacts(account: CloudAccount | null): UseCloudContactsResult {
  const client = useMemo<CloudAuthClient>(() => defaultCloudAuthClient(), []);
  const [contacts, setContacts] = useState<CloudContactSummary[]>([]);
  const [rawRequests, setRawRequests] = useState<CloudContactRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const fetchData = useCallback(async () => {
    if (!account) return;
    const session = await loadSession();
    if (!session?.token) return;
    if (cancelledRef.current) return;
    setLoading(true);
    setError(null);
    try {
      const [list, requests] = await Promise.all([
        client.listContacts(session.token),
        client.listContactRequests(session.token),
      ]);
      if (cancelledRef.current) return;
      setContacts(list);
      setRawRequests(requests);
    } catch (err) {
      if (cancelledRef.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load cloud contacts');
    } finally {
      if (!cancelledRef.current) setLoading(false);
    }
  }, [account, client]);

  // Initial fetch + light polling fallback. Live WS push hooks are
  // wired separately in a later refresh — the gateway exists, but
  // adding the subscription here would double the surface change.
  useEffect(() => {
    if (!account) {
      setContacts([]);
      setRawRequests([]);
      return;
    }
    void fetchData();
    const interval = window.setInterval(() => void fetchData(), REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(interval);
    };
  }, [account, fetchData]);

  const sendRequest = useCallback(
    async (peerAccountId: string, message?: string) => {
      const session = await loadSession();
      if (!session?.token) throw new Error('Not signed in.');
      await client.sendContactRequest(session.token, peerAccountId, message);
      await fetchData();
    },
    [client, fetchData],
  );

  const acceptRequest = useCallback(
    async (requestId: string) => {
      const session = await loadSession();
      if (!session?.token) throw new Error('Not signed in.');
      await client.acceptContactRequest(session.token, requestId);
      await fetchData();
    },
    [client, fetchData],
  );

  const rejectRequest = useCallback(
    async (requestId: string) => {
      const session = await loadSession();
      if (!session?.token) throw new Error('Not signed in.');
      await client.rejectContactRequest(session.token, requestId);
      await fetchData();
    },
    [client, fetchData],
  );

  const mappedContacts = useMemo<Contact[]>(
    () => contacts.map((row) => cloudContactToContact(row)),
    [contacts],
  );
  const mappedRequests = useMemo<ContactRequest[]>(
    () => rawRequests.map((row) => cloudRequestToContactRequest(row)),
    [rawRequests],
  );

  return {
    contacts: mappedContacts,
    requests: mappedRequests,
    loading,
    error,
    refresh: fetchData,
    sendRequest,
    acceptRequest,
    rejectRequest,
  };
}

const CLOUD_HOST_SENTINEL = 'cloud';

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
    bridgeContactStatus: 'accepted',
    bridgeContactRequestDirection: 'outgoing',
    avatarSeed: row.accountId,
    profileImageUrl: row.avatarUrl,
  };
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
    profileImageUrl: row.counterpart?.avatarUrl ?? null,
    avatarSeed: counterpartId,
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
