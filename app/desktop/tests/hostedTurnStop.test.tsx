import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import type { CloudAccount, CloudAuthClient, CloudMessage } from '../src/features/cloud/authClient';
import { parseCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
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
};

async function withHarness(scenario: Scenario, run: (env: {
  stop: () => Promise<boolean>;
  cancelledTurnIds: string[];
  replies: () => { deliveryState?: string; text: string }[];
  stopRequests: string[];
  started: () => boolean;
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
  let started = false;
  let cancelled = false;
  const turn = (): DesktopChatTurnSnapshot => ({
    id: 'turn-1', sessionId, prompt: 'Check disk usage', status: cancelled ? 'cancelled' : 'running', message: '',
    assistantText: '', thinkingText: '', tools: [], completed: cancelled, succeeded: false, startedAtMs: 1,
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
      if (action.endsWith('/progress')) {
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
  const messageIndex = buildCloudMessageIndex('me', { me: [cloudMessage('request-1', 'Check disk usage')] });
  let stop!: (sessionId: string) => Promise<boolean>;
  function Harness() {
    const processedRequestIdsRef = useRef(new Set<string>());
    const turnIdsByRequestIdRef = useRef(new Map<string, string>());
    const [, setLocalTurns] = useState<Record<string, DesktopChatTurnSnapshot>>({});
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
        return response ? [{ deliveryState: response.deliveryState, text: response.text }] : [];
      }),
      stopRequests,
      started: () => started,
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
  await withHarness({ runtimeReady: false }, async ({ stop, stopRequests, started }) => {
    assert.equal(await stop(), true);
    assert.deepEqual(stopRequests, ['request-1']);
    assert.equal(started(), false);
  });
});
