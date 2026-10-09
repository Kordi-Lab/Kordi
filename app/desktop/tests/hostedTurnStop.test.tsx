import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import type { CloudAccount, CloudAuthClient, CloudMessage } from '../src/features/cloud/authClient';
import { encodeCloudAgentResponse, parseCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { CloudAuthError } from '../src/features/cloud/cloudAuthError';
import { buildCloudMessageIndex } from '../src/features/cloud/cloudMessageIndex';
import { __setSessionBackendForTests } from '../src/features/cloud/session';
import { useCloudSelfAgentExecution } from '../src/features/cloud/useCloudSelfAgentExecution';
import type { CanonicalSessionState, DesktopChatTurnSnapshot } from '../src/kordi-app/types';
import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';

const sessionId = 'synthetic-hosted-stop';
const route = { model: 'openai/gpt-6-sol', thinking: 'medium', authProvider: 'openai-codex', authChoice: 'cloud-login:synthetic' };
const account = {
  accountId: 'me', displayName: 'Me', primaryEmail: 'me@example.com', avatarUrl: null,
  avatar: cloudAccountAvatarFixture, nodeId: 'node_me', passwordSet: true,
} as unknown as CloudAccount;

function cloudMessage(messageId: string, body: string): CloudMessage {
  return { messageId, fromAccountId: 'me', toAccountId: 'me', body, sessionId,
    createdAt: new Date().toISOString(), deliveredAt: null, readAt: null };
}

async function waitFor(condition: () => boolean, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  assert.ok(condition(), 'condition was not met in time');
}

type Scenario = {
  /** The server reports a stop requested from another device. */
  admitCancelRequested?: boolean;
  /** This Mac does not execute the request. */
  runtimeReady?: boolean;
  /** The answer text the turn streams before it ends. */
  streamedText?: string;
  /** The server refuses progress after this many publications, as after a lost lease. */
  progressConflictAfter?: number;
  /** Replies other devices already saw for the request. */
  earlierReplies?: string[];
  /** Local turns this Mac already shows. */
  initialLocalTurns?: Record<string, DesktopChatTurnSnapshot>;
  /** What the run-closing route reports. */
  closeResult?: Record<string, unknown>;
  /** An older request in the session that never got an answer. */
  staleOlderRequest?: boolean;
};

type Reply = { deliveryState?: string; text: string; ending?: string };

async function withHarness(scenario: Scenario, run: (env: {
  stop: () => Promise<boolean>;
  cancelledTurnIds: string[];
  replies: () => Reply[];
  stopRequests: string[];
  started: () => boolean;
  closures: Record<string, unknown>[];
  localTurns: () => Record<string, DesktopChatTurnSnapshot>;
}) => Promise<void>) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  __setSessionBackendForTests({ load: async () => ({ token: 'synthetic', accountId: 'me', expiresAt: '2099-01-01' }), save: async () => {}, clear: async () => {} });

  const cancelledTurnIds: string[] = [];
  const progressBodies: string[] = [];
  const stopRequests: string[] = [];
  const closures: Record<string, unknown>[] = [];
  let progressCount = 0;
  let started = false;
  let cancelled = false;
  const turn = (): DesktopChatTurnSnapshot => ({
    id: 'turn-1', sessionId, prompt: 'Check disk usage', status: cancelled ? 'cancelled' : 'running', message: '',
    assistantText: scenario.streamedText ?? '', thinkingText: '', tools: [], completed: cancelled, succeeded: false, startedAtMs: 1,
    replyToMessageId: 'request-1',
  } as unknown as DesktopChatTurnSnapshot);
  mockIPC((command, payload) => {
    const args = payload as Record<string, unknown>;
    if (command === 'desktop_chat_start_message') { started = true; return turn(); }
    if (command === 'desktop_chat_turn_state') return turn();
    if (command === 'desktop_chat_cancel_turn') { cancelledTurnIds.push(String(args.turnId)); cancelled = true; return turn(); }
    if (command.startsWith('desktop_canonical_')) {
      const request = (args.request ?? {}) as Record<string, unknown>;
      return { ...request, sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1 };
    }
    return null;
  });
  const client = {
    async desktopAgentExecution(_token: string, action: string, input: Record<string, unknown>) {
      if (action === 'ready') return { ok: true };
      if (action === 'claim') return { runId: 'run-1', acquired: true, turnIdentity: { ownerAccountId: 'me', requesterAccountId: 'me' } };
      if (action.endsWith('/admit')) return { admitted: true, cancelRequested: Boolean(scenario.admitCancelRequested) };
      if (action.endsWith('/renew')) return { ok: true, cancelRequested: false };
      if (action === 'interrupted') {
        closures.push(input);
        return scenario.closeResult ?? { released: true, closed: true, published: false };
      }
      if (action.endsWith('/progress')) {
        progressCount += 1;
        if (scenario.progressConflictAfter !== undefined && progressCount > scenario.progressConflictAfter) {
          throw new CloudAuthError('execution_lease_lost' as never, 'This runtime no longer owns the request.', 409);
        }
        progressBodies.push(String(input.body));
        return cloudMessage(`response-${progressBodies.length}`, String(input.body));
      }
      throw new Error(`Unexpected execution action: ${action}`);
    },
    async lookupCloudAgentRunForRequest() { return null; },
    async listMessageSnapshot() { return { messages: [] }; },
    async stopCloudAgentRequest(_token: string, requestMessageId: string) { stopRequests.push(requestMessageId); },
  } as unknown as CloudAuthClient;
  const canonicalState = {
    profile: { id: 'synthetic', humanIdentityId: 'human:me', activeAgentIdentityId: 'agent:me' },
    identities: [{ id: 'human:me', kind: 'human' }, { id: 'agent:me', kind: 'agent' }],
    sessions: [{ id: sessionId, kind: 'self-agent', status: 'active', title: 'Stop', primaryIdentityId: 'agent:me',
      createdByIdentityId: 'human:me', createdAtMs: 1, updatedAtMs: 1 }],
    participants: [{ sessionId, identityId: 'human:me', state: 'active' }], messages: [],
    delegatedExchanges: [], presence: [], contextSnapshots: [],
  } as unknown as CanonicalSessionState;
  const messageIndex = buildCloudMessageIndex('me', { me: [
    ...(scenario.staleOlderRequest
      ? [{ ...cloudMessage('request-0', 'Are you there?'), createdAt: new Date(Date.now() - 60_000).toISOString() }]
      : []),
    cloudMessage('request-1', 'Check disk usage'),
    ...(scenario.earlierReplies ?? []).map((body, index) => cloudMessage(`earlier-${index}`, body)),
  ] });
  let localTurns: Record<string, DesktopChatTurnSnapshot> = scenario.initialLocalTurns ?? {};
  let stop!: (sessionId: string) => Promise<boolean>;
  function Harness() {
    const processedRequestIdsRef = useRef(new Set<string>());
    const turnIdsByRequestIdRef = useRef(new Map<string, string>());
    const [turns, setLocalTurns] = useState<Record<string, DesktopChatTurnSnapshot>>(scenario.initialLocalTurns ?? {});
    localTurns = turns;
    const execution = useCloudSelfAgentExecution({
      account, canonicalState, client, messageIndex, initialMessagesSettled: true,
      runtimeReady: scenario.runtimeReady ?? true, routesBySessionId: {}, defaultRoute: route,
      cloudAgentDefinitionsById: {}, processedRequestIdsRef, turnIdsByRequestIdRef, setLocalTurns,
      mergeMessage: () => undefined, syncMessages: async () => undefined, reportWarning: () => undefined,
    });
    stop = execution.stopActiveRequest;
    return null;
  }
  const root = createRoot(document.getElementById('root')!);
  try {
    await act(async () => root.render(<Harness />));
    await run({
      stop: () => stop(sessionId),
      cancelledTurnIds,
      replies: () => progressBodies.flatMap((body) => {
        const response = parseCloudAgentResponse(body);
        return response
          ? [{ deliveryState: response.deliveryState, text: response.text, ...(response.ending ? { ending: response.ending } : {}) }]
          : [];
      }),
      stopRequests,
      started: () => started,
      closures,
      localTurns: () => localTurns,
    });
  } finally {
    await act(async () => root.unmount());
    clearMocks();
    __setSessionBackendForTests(null);
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

const stoppedReply = { deliveryState: 'cancelled', text: 'Request stopped.' };

test('stop on a hosted turn cancels the desktop turn and publishes the stopped reply', async () => {
  await withHarness({}, async ({ stop, cancelledTurnIds, replies, started }) => {
    await waitFor(started);
    await waitFor(() => replies().length > 0);
    assert.equal(await stop(), true);
    await waitFor(() => cancelledTurnIds.length > 0);
    assert.deepEqual(cancelledTurnIds, ['turn-1']);
    // The cancelled reply settles the request, which releases the session queue.
    await waitFor(() => replies().some((reply) => reply.deliveryState === 'cancelled'));
    assert.deepEqual(replies().at(-1), stoppedReply);
  });
});

test('a stop requested from another device reaches the turn this Mac runs', async () => {
  await withHarness({ admitCancelRequested: true }, async ({ cancelledTurnIds, replies }) => {
    await waitFor(() => cancelledTurnIds.length > 0);
    assert.deepEqual(cancelledTurnIds, ['turn-1']);
    await waitFor(() => replies().some((reply) => reply.deliveryState === 'cancelled'));
    assert.deepEqual(replies().at(-1), stoppedReply);
  });
});

test('stop on a request another executor runs asks the server', async () => {
  await withHarness({ runtimeReady: false, closeResult: { released: false, closed: false, published: false } }, async ({ stop, stopRequests, started }) => {
    assert.equal(await stop(), true);
    assert.deepEqual(stopRequests, ['request-1']);
    assert.equal(started(), false);
  });
});

test('stopping mid-stream keeps the partial text, marks it stopped, and ends the run', async () => {
  await withHarness({ streamedText: 'Disk usage is 40% on' }, async ({ stop, started, replies, closures, localTurns }) => {
    await waitFor(started);
    await waitFor(() => replies().length > 0);
    assert.equal(await stop(), true);
    await waitFor(() => replies().some((reply) => reply.deliveryState === 'cancelled'));
    assert.deepEqual(replies().at(-1), { deliveryState: 'cancelled', text: 'Disk usage is 40% on', ending: 'stopped' });
    await waitFor(() => closures.length > 0);
    assert.deepEqual(closures, [{ sessionId, requestMessageId: 'request-1', state: 'cancelled', text: 'Disk usage is 40% on', ending: 'stopped' }]);
    // The live row leaves the running state at once.
    await waitFor(() => localTurns()['request-1']?.completed === true);
    assert.equal(localTurns()['request-1'].ending, 'stopped');
  });
});

test('a lost lease ends the reply as interrupted with its partial text and closes the run', async () => {
  await withHarness({ streamedText: 'Disk usage is 40% on', progressConflictAfter: 0 }, async ({ started, replies, closures, localTurns }) => {
    await waitFor(started);
    // The server can no longer take this Mac's reply, so the closing route
    // ends the run and publishes the same reply.
    await waitFor(() => closures.length > 0, 8_000);
    assert.deepEqual(closures, [{ sessionId, requestMessageId: 'request-1', state: 'failed', text: 'Disk usage is 40% on', ending: 'interrupted' }]);
    assert.equal(replies().some((reply) => reply.deliveryState !== 'processing'), false);
    await waitFor(() => localTurns()['request-1']?.completed === true);
    assert.equal(localTurns()['request-1'].status, 'failed');
    assert.equal(localTurns()['request-1'].assistantText, 'Disk usage is 40% on');
    assert.equal(localTurns()['request-1'].ending, 'interrupted');
    assert.equal(localTurns()['request-1'].error, null);
  });
});

test('stop on a request whose local turn is gone ends it with the text seen so far', async () => {
  const runningTurn = {
    id: 'turn-gone', sessionId, prompt: 'Check disk usage', status: 'writing', message: '', assistantText: 'Disk usage is',
    thinkingText: '', tools: [], completed: false, succeeded: false, startedAtMs: 1, replyToMessageId: 'request-1',
  } as unknown as DesktopChatTurnSnapshot;
  await withHarness({
    runtimeReady: false,
    earlierReplies: [encodeCloudAgentResponse({ requestId: 'request-1', text: 'Disk usage is 40% on', deliveryState: 'processing' })],
    initialLocalTurns: { 'request-1': runningTurn },
    closeResult: { released: true, closed: true, published: true },
  }, async ({ stop, stopRequests, closures, localTurns, started }) => {
    assert.equal(await stop(), true);
    assert.deepEqual(closures, [{ sessionId, requestMessageId: 'request-1', state: 'cancelled', text: 'Disk usage is 40% on', ending: 'stopped' }]);
    // This device's run ended it, so no stop is relayed to another executor.
    assert.deepEqual(stopRequests, []);
    await waitFor(() => !localTurns()['request-1']);
    assert.equal(started(), false);
  });
});

test('stop on a request with no streamed text still ends it with the short notice', async () => {
  await withHarness({ runtimeReady: false, closeResult: { released: true, closed: true, published: true } }, async ({ stop, closures }) => {
    assert.equal(await stop(), true);
    assert.deepEqual(closures, [{ sessionId, requestMessageId: 'request-1', state: 'cancelled', text: 'Request stopped.' }]);
  });
});

test('stop targets the newest unfinished request before a stale older one', async () => {
  await withHarness({
    runtimeReady: false,
    staleOlderRequest: true,
    closeResult: { released: false, closed: false, published: false },
  }, async ({ stop, stopRequests }) => {
    assert.equal(await stop(), true);
    assert.deepEqual(stopRequests, ['request-1']);
  });
});
