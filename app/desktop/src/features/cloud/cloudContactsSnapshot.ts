import type { CloudContactRequest, CloudContactSummary } from './authClient';
import { cloudContactSummaryKey } from './cloudContactTypes';

export type CloudContactsSnapshot = {
  contacts: CloudContactSummary[];
  requests: CloudContactRequest[];
};

export function applyCloudContactsRefreshSnapshot(
  current: CloudContactsSnapshot,
  refreshed: CloudContactsSnapshot,
  revisions: { startedMutationRevision: number; currentMutationRevision: number },
): CloudContactsSnapshot {
  if (revisions.startedMutationRevision !== revisions.currentMutationRevision) return current;

  const contactsByAccountId = new Map<string, CloudContactSummary>();
  for (const contact of current.contacts) contactsByAccountId.set(cloudContactSummaryKey(contact), contact);
  for (const contact of refreshed.contacts) {
    const key = cloudContactSummaryKey(contact);
    const existing = contactsByAccountId.get(key);
    contactsByAccountId.set(
      key,
      existing && cloudContactSummariesEqual(existing, contact) ? existing : contact,
    );
  }
  const contacts = [...contactsByAccountId.values()];
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

function cloudContactSummariesEqual(left: CloudContactSummary, right: CloudContactSummary): boolean {
  return left.contactId === right.contactId
    && left.contactKind === right.contactKind
    && left.accountId === right.accountId
    && left.displayName === right.displayName
    && left.subtitle === right.subtitle
    && left.avatarUrl === right.avatarUrl
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
