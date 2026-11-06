import type { CloudContactRequest, CloudContactSummary, CloudMessage } from './authClient';
import { cloudContactSummaryKey } from './cloudContactTypes';

export type CloudContactsSnapshot = {
  contacts: CloudContactSummary[];
  requests: CloudContactRequest[];
};

/**
 * Applies a server refresh. The server list is authoritative, so a contact
 * deleted or blocked elsewhere drops out; only contacts this client just
 * added (`keepContactKeys`) stay while the server list catches up.
 */
export function applyCloudContactsRefreshSnapshot(
  current: CloudContactsSnapshot,
  refreshed: CloudContactsSnapshot,
  revisions: { startedMutationRevision: number; currentMutationRevision: number },
  keepContactKeys: ReadonlySet<string> = new Set(),
): CloudContactsSnapshot {
  if (revisions.startedMutationRevision !== revisions.currentMutationRevision) return current;

  const refreshedByKey = new Map<string, CloudContactSummary>();
  for (const contact of refreshed.contacts) refreshedByKey.set(cloudContactSummaryKey(contact), contact);
  // Known contacts keep their place; new ones follow in server order.
  const contactsByKey = new Map<string, CloudContactSummary>();
  for (const contact of current.contacts) {
    const key = cloudContactSummaryKey(contact);
    const fresh = refreshedByKey.get(key);
    if (fresh) contactsByKey.set(key, cloudContactSummariesEqual(contact, fresh) ? contact : fresh);
    else if (keepContactKeys.has(key)) contactsByKey.set(key, contact);
  }
  for (const [key, contact] of refreshedByKey) {
    if (!contactsByKey.has(key)) contactsByKey.set(key, contact);
  }
  const contacts = [...contactsByKey.values()];
  const acceptedAccountIds = new Set(contacts
    .filter((contact) => contact.contactKind !== 'system_agent')
    .map((contact) => contact.accountId));
  const currentRequestsById = new Map(
    current.requests.map((request) => [request.requestId, request]),
  );
  const requests = refreshed.requests.filter((request) => {
    const counterpartId = request.counterpart?.accountId
      || (request.direction === 'incoming' ? request.fromAccountId : request.toAccountId);
    return !acceptedAccountIds.has(counterpartId);
  }).map((request) => {
    const existing = currentRequestsById.get(request.requestId);
    return existing && cloudContactRequestsEqual(existing, request) ? existing : request;
  });

  return {
    contacts: cloudContactSummaryArraysEqual(current.contacts, contacts) ? current.contacts : contacts,
    requests: cloudContactRequestArraysEqual(current.requests, requests) ? current.requests : requests,
  };
}

/** Drops the person contact for `accountId`; a system agent sharing the account stays. */
export function removeCloudContactSummarySnapshot(
  snapshot: CloudContactsSnapshot,
  accountId: string,
): CloudContactsSnapshot {
  const id = accountId.trim();
  const contacts = snapshot.contacts.filter((contact) => contact.contactKind === 'system_agent' || contact.accountId !== id);
  return contacts.length === snapshot.contacts.length ? snapshot : { ...snapshot, contacts };
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

export function removeCloudContactRequestSnapshot(
  snapshot: CloudContactsSnapshot,
  requestId: string,
): CloudContactsSnapshot {
  return {
    ...snapshot,
    requests: snapshot.requests.filter((item) => item.requestId !== requestId),
  };
}

export function cloudContactAddedOccurredAt(payload: unknown): string {
  return cleanText(objectRecord(payload)?.occurred_at);
}

function cloudContactSummariesEqual(left: CloudContactSummary, right: CloudContactSummary): boolean {
  return left.contactId === right.contactId
    && left.contactKind === right.contactKind
    && left.accountId === right.accountId
    && left.kordiId === right.kordiId
    && left.displayName === right.displayName
    && left.subtitle === right.subtitle
    && left.avatarUrl === right.avatarUrl
    && left.defaultAgent?.agentId === right.defaultAgent?.agentId
    && left.defaultAgent?.displayName === right.defaultAgent?.displayName
    && left.defaultAgent?.avatarUrl === right.defaultAgent?.avatarUrl
    && left.defaultAgent?.avatar.version === right.defaultAgent?.avatar.version
    && left.nodeId === right.nodeId
    && left.createdAt === right.createdAt
    && left.locked === right.locked
    && left.targetCloudAgentId === right.targetCloudAgentId
    && left.targetCloudAgentName === right.targetCloudAgentName
    && left.targetCloudAgentOwnerAccountId === right.targetCloudAgentOwnerAccountId
    && left.targetCloudAgentOwnerName === right.targetCloudAgentOwnerName
    && left.supportTicketEnabled === right.supportTicketEnabled;
}

function cloudContactRequestsEqual(left: CloudContactRequest, right: CloudContactRequest): boolean {
  return left.requestId === right.requestId
    && left.fromAccountId === right.fromAccountId
    && left.toAccountId === right.toAccountId
    && left.status === right.status
    && left.direction === right.direction
    && left.message === right.message
    && left.createdAt === right.createdAt
    && left.decidedAt === right.decidedAt
    && (
      left.counterpart === right.counterpart
      || Boolean(
        left.counterpart
        && right.counterpart
        && cloudContactSummariesEqual(left.counterpart, right.counterpart),
      )
    );
}

function cloudContactSummaryArraysEqual(
  left: readonly CloudContactSummary[],
  right: readonly CloudContactSummary[],
): boolean {
  return left.length === right.length
    && left.every((contact, index) => cloudContactSummariesEqual(contact, right[index]));
}

function cloudContactRequestArraysEqual(
  left: readonly CloudContactRequest[],
  right: readonly CloudContactRequest[],
): boolean {
  return left.length === right.length
    && left.every((request, index) => cloudContactRequestsEqual(request, right[index]));
}
