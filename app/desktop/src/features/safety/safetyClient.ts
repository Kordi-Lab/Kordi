// Block and report routes. Every call goes through CloudAuthClient.request so
// timeouts and error decoding match the rest of the hosted API.

import { CloudAuthError, defaultCloudAuthClient, type CloudAuthClient } from '@/features/cloud/authClient';
import { loadSession } from '@/features/cloud/session';

import type {
  CloudBlockedAccount,
  CloudBlockResult,
  CloudReportInput,
  CloudReportResult,
} from './safetyTypes';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SafetyClient = {
  listBlocks(this: void, token: string): Promise<CloudBlockedAccount[]>;
  block(this: void, token: string, accountId: string): Promise<CloudBlockResult>;
  unblock(this: void, token: string, accountId: string): Promise<void>;
  report(this: void, token: string, input: CloudReportInput): Promise<CloudReportResult>;
  /** The chat sync v2 conversation id for a conversation or session id, if known. */
  resolveConversationId(this: void, token: string, conversationOrSessionId: string): Promise<string | null>;
};

/** Resolves the signed-in session. Previews and tests inject a synthetic one. */
export type SafetySessionLoader = () => Promise<{ token: string; accountId: string } | null>;

export type SafetyDeps = {
  client: SafetyClient;
  loadSession: SafetySessionLoader;
};

type SafetyAuthClient = Pick<CloudAuthClient, 'request' | 'bootstrapChatSync'>;

/**
 * True only for the empty 404 a server returns for a route it does not have.
 * Known routes answer a missing record with an error code.
 */
export function isMissingRoute(error: unknown): boolean {
  return error instanceof CloudAuthError && error.status === 404 && error.code === 'unknown';
}

export function isCloudUuid(value: string | null | undefined): boolean {
  return UUID_PATTERN.test(value?.trim() ?? '');
}

function bearer(token: string, json = false): Record<string, string> {
  return json
    ? { 'content-type': 'application/json', authorization: `Bearer ${token}` }
    : { authorization: `Bearer ${token}` };
}

const blockPath = (accountId: string) => {
  const trimmed = accountId.trim();
  if (!trimmed) throw new Error('Missing account.');
  return `/v1/cloud/blocks/${encodeURIComponent(trimmed)}`;
};

export function createSafetyClient(auth: SafetyAuthClient): SafetyClient {
  return {
    async listBlocks(token) {
      const response = await auth.request<{ blocks?: CloudBlockedAccount[] } | null>(
        '/v1/cloud/blocks',
        { method: 'GET', headers: bearer(token) },
        'Could not load blocked people.',
      );
      return Array.isArray(response?.blocks) ? response.blocks : [];
    },
    async block(token, accountId) {
      const response = await auth.request<CloudBlockResult | null>(
        blockPath(accountId),
        { method: 'PUT', headers: bearer(token, true), body: '{}' },
        'Could not block.',
      );
      if (!response?.block) throw new Error('Empty response from cloud server.');
      return { block: response.block, removedContact: response.removedContact === true };
    },
    async unblock(token, accountId) {
      await auth.request<void>(
        blockPath(accountId),
        { method: 'DELETE', headers: bearer(token) },
        'Could not unblock.',
      );
    },
    async report(token, input) {
      const response = await auth.request<Partial<CloudReportResult> | null>(
        '/v1/cloud/reports',
        { method: 'POST', headers: bearer(token, true), body: JSON.stringify(input) },
        'Could not send the report.',
      );
      if (!response?.report) throw new Error('Empty response from cloud server.');
      return { report: response.report, blocked: response.blocked === true };
    },
    async resolveConversationId(token, conversationOrSessionId) {
      const wanted = conversationOrSessionId.trim();
      if (!wanted) return null;
      if (isCloudUuid(wanted)) return wanted;
      const bootstrap = await auth.bootstrapChatSync(token);
      return bootstrap.conversations.find((conversation) => (
        conversation.id === wanted || conversation.legacy_session_id?.trim() === wanted
      ))?.id ?? null;
    },
  };
}

let defaultDeps: SafetyDeps | null = null;

export function defaultSafetyDeps(): SafetyDeps {
  defaultDeps ??= {
    client: createSafetyClient(defaultCloudAuthClient()),
    loadSession: async () => {
      const session = await loadSession();
      return session?.token && session.accountId ? { token: session.token, accountId: session.accountId } : null;
    },
  };
  return defaultDeps;
}

/** The signed-in token for `accountId`, or a sign-in error. */
export async function safetySessionToken(deps: SafetyDeps, accountId: string | null): Promise<string> {
  const session = await deps.loadSession();
  if (!session?.token || !accountId || session.accountId !== accountId) {
    throw new CloudAuthError('invalid_session', 'Sign in again to continue.', 401);
  }
  return session.token;
}
