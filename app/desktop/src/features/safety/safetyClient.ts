// Contact removal, blocking, reports, and leaving groups. Every call goes
// through CloudAuthClient.request so timeouts and error decoding match the
// rest of the hosted API.

import { CloudAuthError, type CloudAuthClient } from '@/features/cloud/authClient';
import type { ChatSyncConversation } from '@/features/cloud/chatSyncTypes';

import type {
  CloudBlockedAccount,
  CloudBlockResult,
  CloudLeaveConversationResult,
  CloudReportInput,
  CloudReportReceipt,
} from './safetyTypes';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function jsonBearer(token: string): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${token}` };
}

/**
 * True only for the empty 404 a server returns for a route it does not have.
 * Known routes answer a missing record with an error code, so those 404s are
 * never read as an older server.
 */
export function isMissingRoute(error: unknown): boolean {
  return error instanceof CloudAuthError && error.status === 404 && error.code === 'unknown';
}

export function isCloudUuid(value: string | null | undefined): boolean {
  return UUID_PATTERN.test(value?.trim() ?? '');
}

export async function removeContact(
  client: CloudAuthClient,
  token: string,
  peerAccountId: string,
): Promise<void> {
  await client.request<void>(
    `/v1/cloud/contacts/${encodeURIComponent(peerAccountId)}`,
    { method: 'DELETE', headers: bearer(token) },
    'Could not remove this contact.',
  );
}

export async function withdrawContactRequest(
  client: CloudAuthClient,
  token: string,
  requestId: string,
): Promise<void> {
  await client.request<void>(
    `/v1/cloud/contacts/requests/${encodeURIComponent(requestId)}/withdraw`,
    { method: 'POST', headers: bearer(token) },
    "Couldn't withdraw the request. Try again.",
  );
}

export async function listBlockedAccounts(
  client: CloudAuthClient,
  token: string,
): Promise<CloudBlockedAccount[]> {
  const response = await client.request<{ blocks?: CloudBlockedAccount[] } | null>(
    '/v1/cloud/blocks',
    { method: 'GET', headers: bearer(token) },
    'Could not load blocked accounts.',
  );
  return Array.isArray(response?.blocks) ? response.blocks : [];
}

export async function blockAccount(
  client: CloudAuthClient,
  token: string,
  accountId: string,
): Promise<CloudBlockResult> {
  const response = await client.request<CloudBlockResult | null>(
    `/v1/cloud/blocks/${encodeURIComponent(accountId)}`,
    { method: 'PUT', headers: bearer(token) },
    'Could not block this account.',
  );
  if (!response?.block) throw new Error('Empty response from cloud server.');
  return response;
}

export async function unblockAccount(
  client: CloudAuthClient,
  token: string,
  accountId: string,
): Promise<void> {
  await client.request<void>(
    `/v1/cloud/blocks/${encodeURIComponent(accountId)}`,
    { method: 'DELETE', headers: bearer(token) },
    'Could not unblock this account.',
  );
}

export async function createReport(
  client: CloudAuthClient,
  token: string,
  input: CloudReportInput,
): Promise<CloudReportReceipt> {
  const response = await client.request<{ report?: CloudReportReceipt } | null>(
    '/v1/cloud/reports',
    { method: 'POST', headers: jsonBearer(token), body: JSON.stringify(input) },
    "Couldn't send your report. Your selections are kept. Try again.",
  );
  if (!response?.report) throw new Error('Empty response from cloud server.');
  return response.report;
}

function newOperationId(): string {
  return globalThis.crypto.randomUUID();
}

/** Leaves a group. Call it on the group's main conversation to leave every channel. */
export async function leaveConversation(
  client: CloudAuthClient,
  token: string,
  conversationId: string,
  successorAccountId: string | null,
): Promise<CloudLeaveConversationResult> {
  const response = await client.request<{
    left_conversation_ids?: string[];
    successor_account_id?: string | null;
  } | null>(
    `/v2/chat/conversations/${encodeURIComponent(conversationId)}/leave`,
    {
      method: 'POST',
      headers: jsonBearer(token),
      // A fresh operation id per user action: a later leave after rejoining
      // must not replay this one.
      body: JSON.stringify({
        client_operation_id: newOperationId(),
        successor_account_id: successorAccountId,
      }),
    },
    "Couldn't leave the group. Check your connection and try again.",
  );
  return {
    leftConversationIds: Array.isArray(response?.left_conversation_ids) ? response.left_conversation_ids : [],
    successorAccountId: response?.successor_account_id ?? null,
  };
}

/**
 * Finds the hosted conversation for a cloud conversation id or the session id
 * the desktop knows it by.
 */
export async function resolveCloudConversation(
  client: CloudAuthClient,
  token: string,
  conversationOrSessionId: string,
): Promise<ChatSyncConversation | null> {
  const wanted = conversationOrSessionId.trim();
  if (!wanted) return null;
  const bootstrap = await client.bootstrapChatSync(token);
  return bootstrap.conversations.find((conversation) => (
    conversation.id === wanted || conversation.legacy_session_id?.trim() === wanted
  )) ?? null;
}

/** The cloud conversation id for a report, resolving a session id when needed. */
export async function resolveCloudConversationId(
  client: CloudAuthClient,
  token: string,
  conversationOrSessionId: string,
): Promise<string | null> {
  const value = conversationOrSessionId.trim();
  if (isCloudUuid(value)) return value;
  return (await resolveCloudConversation(client, token, value))?.id ?? null;
}
