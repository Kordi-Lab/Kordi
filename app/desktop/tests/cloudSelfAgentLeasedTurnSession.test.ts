import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import { parseCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { holdLeasedTurnSession, sessionRunsLeasedTurn } from '../src/features/cloud/cloudLeasedTurnSessions';
import { buildCloudMessageIndex } from '../src/features/cloud/cloudMessageIndex';
import { executeCloudSelfAgentRequest } from '../src/features/cloud/cloudSelfAgentRequestExecution';
import type { DesktopChatTurnSnapshot } from '../src/kordi-app/types';
import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';

const account: CloudAccount = {
  accountId: 'acct_me', displayName: 'Owner', primaryEmail: 'owner@example.com', avatarUrl: null,
  avatar: cloudAccountAvatarFixture, nodeId: 'node_me', passwordSet: true,
};
const sessionId = '00000000-0000-4000-8000-0000000000bb';
const request: CloudMessage = {
  messageId: 'request-1', fromAccountId: account.accountId, toAccountId: account.accountId,
  body: 'Say hello', sessionId, createdAt: '2026-10-19T12:00:00.000Z', deliveredAt: null, readAt: null,
};
const turn = (completed: boolean): DesktopChatTurnSnapshot => ({
  id: 'turn-1', sessionId, prompt: 'Say hello', status: completed ? 'complete' : 'running',
  message: completed ? 'Complete' : 'Replying…', assistantText: completed ? 'Hello there.' : 'Hel',
  thinkingText: '', tools: [], completed, succeeded: completed, startedAtMs: 1,
  completedAtMs: completed ? 2 : null, replyToMessageId: request.messageId,
});

test('a session hold is counted and released once', () => {
  const first = holdLeasedTurnSession('session-a');
  const second = holdLeasedTurnSession('session-a');
  first();
  first();
  assert.equal(sessionRunsLeasedTurn('session-a'), true, 'the second hold remains');
  second();
  assert.equal(sessionRunsLeasedTurn('session-a'), false);
  assert.equal(sessionRunsLeasedTurn(''), false);
});

test('a leased turn holds its session and a late progress snapshot never reopens it', async () => {
  const merged: CloudMessage[] = [];
  const heldWhileStarting: boolean[] = [];
  let turnStatePolls = 0;
  let releaseFirstProgress: (() => void) | null = null;
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, unknown> = {}) => {
      if (command === 'cloud_session_load') {
        return { token: 'token', accountId: account.accountId, expiresAt: '2099-01-01T00:00:00.000Z' };
      }
      if (command === 'desktop_chat_start_message') {
        heldWhileStarting.push(sessionRunsLeasedTurn(sessionId));
        return turn(false);
      }
      if (command === 'desktop_chat_turn_state') {
        turnStatePolls += 1;
        // The turn ends while its first progress snapshot is still in flight.
        return turn(true);
      }
      const value = (args.request ?? args) as Record<string, unknown>;
      return { ...value, id: String(value.id ?? command), sessionId, messages: [] };
    } },
  } });
  let progressCount = 0;
  const client = {
    async desktopAgentExecution<T>(_token: string, action: string, input: Record<string, unknown>): Promise<T> {
      if (action === 'claim') {
        return { runId: 'run-a', acquired: true, turnIdentity: { ownerAccountId: account.accountId, requesterAccountId: account.accountId } } as T;
      }
      if (action.endsWith('/admit')) return { admitted: true } as T;
      if (action.endsWith('/renew')) return {} as T;
      if (action.endsWith('/progress')) {
        progressCount += 1;
        if (progressCount === 1) {
          await new Promise<void>((resolve) => { releaseFirstProgress = resolve; });
        }
        return {
          ...request, messageId: `response-${progressCount}`, body: String(input.body),
          clientMessageId: String(input.clientMessageId),
        } as T;
      }
      throw new Error(`unexpected ${action}`);
    },
    lookupCloudAgentRunForRequest: async () => null,
    listMessageSnapshot: async () => ({ messages: [] }),
  };
  const releaseWhenPolled = setInterval(() => {
    if (turnStatePolls > 0 && releaseFirstProgress) releaseFirstProgress();
  }, 10);
  try {
    await executeCloudSelfAgentRequest({
      account,
      canonicalState: {
        storagePath: '/tmp/canonical.sqlite3', identities: [], sessions: [], participants: [], messages: [],
        delegatedExchanges: [], presence: [], contextSnapshots: [],
        profile: { id: 'profile', storageRoot: '/tmp', humanIdentityId: 'human:acct_me', createdAtMs: 1, updatedAtMs: 1 },
      } as never,
      client: client as never,
      messageIndex: buildCloudMessageIndex(account.accountId, { [account.accountId]: [request] }),
      defaultRoute: null,
      cloudAgentDefinitionsById: {},
      processedRequestIdsRef: { current: new Set([request.messageId]) },
      turnIdsByRequestIdRef: { current: new Map() },
      setLocalTurns: () => undefined,
      mergeMessage: (message: CloudMessage) => { merged.push(message); },
      syncMessages: async () => undefined,
      reportWarning: () => undefined,
      request,
      voice: undefined,
      selfMessages: [request],
      candidateRuntimeSessionId: sessionId,
      effectiveRoutesBySessionId: {},
      requestRoute: null,
      isInactive: () => false,
      supersededRequestIdsRef: { current: new Set() },
      activeRequestsRef: { current: new Map() },
      streamedTextByRequestIdRef: { current: new Map() },
    } as never);
  } finally {
    clearInterval(releaseWhenPolled);
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
  assert.deepEqual(heldWhileStarting, [true], 'the session is held before the native turn exists');
  assert.equal(sessionRunsLeasedTurn(sessionId), false, 'the hold ends with the request');
  assert.deepEqual(
    merged.map((message) => parseCloudAgentResponse(message.body)?.deliveryState),
    ['complete'],
    'only the terminal reply reaches the transcript after the turn ended',
  );
});
