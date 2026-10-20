import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CloudAccount, CloudAuthClient, CloudMessage } from '../src/features/cloud/authClient';
import { CloudAuthError } from '../src/features/cloud/cloudAuthError';
import { handBackDesktopRun } from '../src/features/cloud/cloudDesktopRunHandback';
import { buildCloudMessageIndex } from '../src/features/cloud/cloudMessageIndex';
import { executeCloudSelfAgentRequest } from '../src/features/cloud/cloudSelfAgentRequestExecution';
import type { DesktopChatTurnSnapshot } from '../src/kordi-app/types';
import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';

type Call = { action: string; input: Record<string, unknown> };

function fakeClient(respond: (action: string) => unknown) {
  const calls: Call[] = [];
  const client = {
    async desktopAgentExecution<T>(_token: string, action: string, input: Record<string, unknown>): Promise<T> {
      calls.push({ action, input });
      const value = respond(action);
      if (value instanceof Error) throw value;
      return value as T;
    },
  } as unknown as Pick<CloudAuthClient, 'desktopAgentExecution'>;
  return { client, calls };
}

const lease = (disposed: string[]) => ({
  runId: 'run-a', claimId: 'claim-a', dispose: () => { disposed.push('disposed'); },
});

test('a hand-back stops renewing and releases the claimed run to the cloud', async () => {
  const disposed: string[] = [];
  const { client, calls } = fakeClient(() => ({ released: true }));
  assert.equal(await handBackDesktopRun(client, 'token', lease(disposed)), true);
  assert.deepEqual(calls, [{ action: 'run-a/release', input: { claimId: 'claim-a' } }]);
  assert.deepEqual(disposed, ['disposed']);
});

test('a run the cloud cannot answer stays with this Mac', async () => {
  const { client } = fakeClient(() => ({ released: false }));
  assert.equal(await handBackDesktopRun(client, 'token', lease([])), false);
  const refused = fakeClient(() => new CloudAuthError('unknown', 'Gone', 409));
  assert.equal(await handBackDesktopRun(refused.client, 'token', lease([]), { retryMs: 0 }), false);
  assert.equal(refused.calls.length, 1, 'a refusal is not retried');
});

test('a failed hand-back request is retried', async () => {
  let attempts = 0;
  const { client, calls } = fakeClient(() => (
    ++attempts < 3 ? new CloudAuthError('unknown', 'Unavailable', 503) : { released: true }
  ));
  assert.equal(await handBackDesktopRun(client, 'token', lease([]), { retryMs: 0 }), true);
  assert.equal(calls.length, 3);
});

const account: CloudAccount = {
  accountId: 'acct_me', displayName: 'Owner', primaryEmail: 'owner@example.com', avatarUrl: null,
  avatar: cloudAccountAvatarFixture, nodeId: 'node_me', passwordSet: true,
};
const sessionId = '00000000-0000-4000-8000-0000000000aa';
const request: CloudMessage = {
  messageId: 'request-1', fromAccountId: account.accountId, toAccountId: account.accountId,
  body: 'Check disk usage', sessionId, createdAt: '2026-10-19T12:00:00.000Z', deliveredAt: null, readAt: null,
};

/** Runs one self-agent request with a native runtime whose turn start is `start`. */
async function runRequest(
  start: () => DesktopChatTurnSnapshot | Error,
  release: { released: boolean },
  failingCommand?: string,
) {
  const commands: string[] = [];
  const warnings: string[] = [];
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, unknown> = {}) => {
      commands.push(command);
      if (command === failingCommand) throw new Error('Slow local store.');
      if (command === 'cloud_session_load') {
        return { token: 'token', accountId: account.accountId, expiresAt: '2099-01-01T00:00:00.000Z' };
      }
      if (command === 'desktop_chat_start_message') {
        const result = start();
        if (result instanceof Error) throw result;
        return result;
      }
      const value = (args.request ?? args) as Record<string, unknown>;
      return { ...value, id: String(value.id ?? command), sessionId, messages: [] };
    } },
  } });
  const { client, calls } = fakeClient((action) => {
    if (action === 'claim') {
      return { runId: 'run-a', acquired: true, turnIdentity: { ownerAccountId: account.accountId, requesterAccountId: account.accountId } };
    }
    if (action.endsWith('/admit')) return { admitted: true };
    if (action.endsWith('/release')) return release;
    if (action === 'interrupted') return { released: true, closed: true, published: true };
    return new Error(`unexpected ${action}`);
  });
  const localTurns: Record<string, DesktopChatTurnSnapshot> = {};
  try {
    await executeCloudSelfAgentRequest({
      account,
      canonicalState: {
        storagePath: '/tmp/canonical.sqlite3', identities: [], sessions: [], participants: [], messages: [],
        delegatedExchanges: [], presence: [], contextSnapshots: [],
        profile: { id: 'profile', storageRoot: '/tmp', humanIdentityId: 'human:acct_me', createdAtMs: 1, updatedAtMs: 1 },
      } as never,
      client: {
        ...client,
        lookupCloudAgentRunForRequest: async () => null,
        listMessageSnapshot: async () => ({ messages: [] }),
      } as never,
      messageIndex: buildCloudMessageIndex(account.accountId, { [account.accountId]: [request] }),
      defaultRoute: null,
      cloudAgentDefinitionsById: {},
      processedRequestIdsRef: { current: new Set([request.messageId]) },
      turnIdsByRequestIdRef: { current: new Map() },
      setLocalTurns: (update) => {
        const next = typeof update === 'function' ? update(localTurns) : update;
        for (const key of Object.keys(localTurns)) delete localTurns[key];
        Object.assign(localTurns, next);
      },
      mergeMessage: () => undefined,
      syncMessages: async () => undefined,
      reportWarning: (message: string, error: unknown) => { warnings.push(`${message}: ${String(error)}`); },
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
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
  return { actions: calls.map((call) => call.action), commands, localTurns, warnings };
}

test('a Mac that cannot start the turn hands the request to the cloud without a failed reply', async () => {
  const { actions, localTurns } = await runRequest(
    () => new Error('The runtime could not start the turn.'),
    { released: true },
  );
  assert.deepEqual(actions, ['claim', 'run-a/admit', 'run-a/release']);
  assert.equal(localTurns[request.messageId], undefined, 'no failed turn remains on this Mac');
});

test('a request the cloud cannot take keeps its failure reply', async () => {
  const { actions, localTurns } = await runRequest(
    () => new Error('The runtime could not start the turn.'),
    { released: false },
  );
  assert.equal(actions.includes('run-a/release'), true);
  assert.equal(actions.at(-1), 'interrupted', 'the run ends with its failure reply');
  assert.equal(localTurns[request.messageId]?.status, 'failed');
});

test('a turn that started and failed keeps its failure reply', async () => {
  const { actions } = await runRequest(() => ({
    id: 'turn-1', sessionId, prompt: 'Check disk usage', status: 'failed', message: 'Provider failed',
    error: 'Provider failed', assistantText: '', thinkingText: '', tools: [], completed: true, succeeded: false,
    startedAtMs: 1, completedAtMs: 2, replyToMessageId: request.messageId,
  }), { released: true });
  assert.equal(actions.includes('run-a/release'), false);
  assert.equal(actions.at(-1), 'interrupted');
});

test('a failure before admission also hands the request to the cloud', async () => {
  const { actions, warnings } = await runRequest(
    () => new Error('unreachable'),
    { released: true },
    'desktop_canonical_upsert_message_fast',
  );
  assert.deepEqual(actions, ['claim', 'run-a/release']);
  assert.equal(warnings.some((warning) => warning.includes('handed back')), true);
});
