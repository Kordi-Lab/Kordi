import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { CloudAuthClient, type CloudAccount, type ChatSyncConversation } from '../src/features/cloud/authClient';
import type { CanonicalSessionMessage, CanonicalSessionState } from '../src/kordi-app/types';
import { __setSessionBackendForTests } from '../src/features/cloud/session';
import { DESKTOP_READINESS_PUBLICATION_DEADLINE_MS, useDesktopAgentReadiness } from '../src/features/cloud/useDesktopAgentReadiness';
import { CLOUD_SELF_AGENT_RECONCILE_DEADLINE_MS, useCloudSelfAgentForwardSync } from '../src/features/cloud/useCloudSelfAgentForwardSync';
import { saveCloudSelfAgentForwardCutoff } from '../src/features/cloud/cloudSelfAgentForwardSync';
import { PromiseDeadlineError, untilAborted, withDeadline } from '../src/lib/promiseDeadline';
import { mockNativeHttpInvoke } from './helpers/nativeHttp';

// A webview reload while native work is running can leave a reply that never
// arrives, and a stalled response body never finishes. These tests pin that
// such a promise can no longer stop a send or the readiness heartbeat for the
// rest of the session.

const never = <T,>() => new Promise<T>(() => {});

async function flush(rounds = 30) {
  for (let round = 0; round < rounds; round += 1) {
    await act(async () => { await new Promise(resolve => setImmediate(resolve)); });
  }
}

// Mocked timers do not cover module loading, so wait for the observable step.
async function settle(predicate: () => boolean) {
  for (let round = 0; round < 2_000 && !predicate(); round += 1) await flush(1);
  assert.ok(predicate(), 'Expected asynchronous work to reach its next step');
}

async function tick(ms: number) {
  await act(async () => { mock.timers.tick(ms); });
}

function installDom() {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const globals = { window: dom.window, document: dom.window.document, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  __setSessionBackendForTests({
    load: async () => ({ token: 'synthetic', accountId: 'me', expiresAt: '2099-01-01T00:00:00Z' }),
    save: async () => {}, clear: async () => {},
  });
  const root = createRoot(document.getElementById('root')!);
  return {
    root,
    async close() {
      await act(async () => { root.unmount(); });
      clearMocks();
      __setSessionBackendForTests(null);
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      dom.window.close();
    },
  };
}

test('withDeadline rejects a promise that never settles and passes through settled ones', async () => {
  assert.equal(await withDeadline(Promise.resolve(3), 1_000, 'unused'), 3);
  let timedOut = false;
  await assert.rejects(withDeadline(never(), 5, 'Synthetic deadline', () => { timedOut = true; }), PromiseDeadlineError);
  assert.equal(timedOut, true);
});

test('untilAborted settles on abort and hands a late value to its owner', async () => {
  const controller = new AbortController();
  let resolveLate!: (value: number) => void;
  const late = new Promise<number>(resolve => { resolveLate = resolve; });
  const released: number[] = [];
  const pending = untilAborted(late, controller.signal, () => new Error('Synthetic cancel'), value => released.push(value));
  controller.abort();
  await assert.rejects(pending, /Synthetic cancel/);
  resolveLate(7);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(released, [7]);
});

async function withNativeInvoke<T>(invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>, run: () => Promise<T>) {
  const originalWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: { invoke } };
  try { return await run(); } finally {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = originalWindow;
  }
}

for (const stuck of ['plugin:http|fetch', 'plugin:http|fetch_send', 'plugin:http|fetch_read_body']) {
  test(`a native request whose ${stuck.split('|')[1]} reply never arrives still times out`, async () => {
    const base = mockNativeHttpInvoke(async () => Response.json({ ok: true }));
    const commands: string[] = [];
    const invoke = async (command: string, args: Record<string, unknown>) => {
      commands.push(command);
      return command === stuck ? never() : base(command, args);
    };
    await withNativeInvoke(invoke, async () => {
      const client = new CloudAuthClient({ baseUrl: 'http://localhost', requestTimeoutMs: 20 });
      await assert.rejects(client.desktopAgentExecution('synthetic', 'ready', {}), /timed out/);
    });
    if (stuck === 'plugin:http|fetch_read_body') {
      assert.ok(commands.includes('plugin:http|fetch_cancel_body'), 'a stalled body releases its response');
    }
  });
}

test('a readiness publication that never settles no longer stops later heartbeats', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const view = installDom();
  mockIPC(() => null);
  const replies: Array<'hang' | 'ok'> = ['hang', 'ok'];
  let calls = 0;
  const warnings: string[] = [];
  const client = new CloudAuthClient('http://localhost');
  client.desktopAgentExecution = async <T,>(): Promise<T> => {
    calls += 1;
    return (replies.shift() ?? 'ok') === 'hang' ? never<T>() : {} as T;
  };
  let ready = false;
  const reportWarning = (message: string) => { warnings.push(message); };
  function Probe() {
    ready = useDesktopAgentReadiness({ account: { accountId: 'me' } as CloudAccount, client, reportWarning });
    return null;
  }
  try {
    await act(async () => { view.root.render(<Probe />); });
    await settle(() => calls === 1);
    for (let elapsed = 10_000; elapsed < DESKTOP_READINESS_PUBLICATION_DEADLINE_MS; elapsed += 10_000) {
      await tick(10_000);
      await flush(5);
    }
    assert.equal(calls, 1, 'heartbeats wait while one publication is in flight');
    await tick(10_000);
    await settle(() => warnings.some(message => message.includes('readiness failed')));
    await tick(10_000);
    await settle(() => calls === 2 && ready);
  } finally {
    await view.close();
    mock.timers.reset();
  }
});

test('an Ask Agent send is published after a stuck forward sync is released', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const view = installDom();
  const sessionId = 'session:agent:reload';
  const conversation = { id: 'conversation-reload', kind: 'ai', legacy_session_id: sessionId,
    latest_message_sequence: 0, created_at: '2026-01-01T00:00:00Z' } as ChatSyncConversation;
  saveCloudSelfAgentForwardCutoff('me', Date.now() - 1_000);
  const message: CanonicalSessionMessage = {
    id: 'msg:ui:reload-request', sessionId, senderIdentityId: 'human:me', senderRole: 'user',
    messageKind: 'text', contentText: 'Synthetic request after reload', status: 'sent', sequenceNum: 1,
    createdAtMs: Date.now(), updatedAtMs: Date.now(), sourceTransport: 'desktop-chat-ui', sourceEventId: 'reload-request',
  };
  const state = {
    sessions: [{ id: sessionId, kind: 'self-agent', status: 'active', title: 'Synthetic chat' }],
    identities: [], participants: [], profile: { id: 'synthetic' }, messages: [message],
  } as unknown as CanonicalSessionState;
  let conversationReads = 0;
  mockIPC((command) => {
    if (command === 'desktop_chat_sync_conversations') {
      conversationReads += 1;
      // The first read's reply is lost, as after a webview reload mid-command.
      return conversationReads === 1 ? never() : [conversation];
    }
    if (command === 'desktop_chat_sync_message_refs') return [];
    if (command === 'desktop_canonical_session_messages') return { messages: [message], hasOlder: false, oldestSequenceNum: 1 };
    throw new Error('Unexpected IPC: ' + command);
  });
  const sent: string[] = [];
  const warnings: string[] = [];
  const client = {
    listChatConversationHistoryPage: async () => ({ messages: [], hasMore: false, nextBeforeSequence: null }),
    sendMessage: async (_token: string, _peer: string, body: string) => { sent.push(body); return { messageId: 'wire-' + sent.length }; },
  } as unknown as CloudAuthClient;
  function Harness() {
    useCloudSelfAgentForwardSync({ account: { accountId: 'me' } as CloudAccount, canonicalState: state,
      canonicalStateRef: { current: state }, initialMessagesSettled: true, client, cancelledRef: { current: false },
      processedRequestIdsRef: { current: new Set() }, mergeMessage: () => {}, syncCloudCollaborationDiff: async () => {},
      reportWarning: (warning) => { warnings.push(warning); } });
    return null;
  }
  try {
    await act(async () => { view.root.render(<Harness />); });
    await settle(() => conversationReads === 1);
    await flush();
    assert.deepEqual(sent, []);
    await tick(CLOUD_SELF_AGENT_RECONCILE_DEADLINE_MS);
    await settle(() => warnings.some(warning => warning.includes('stuck')));
    await tick(31_000);
    await settle(() => sent.length > 0);
    assert.equal(conversationReads, 2, 'the released run is retried without another local change');
    assert.equal(sent.filter(body => body.includes('Synthetic request after reload')).length, 1);
  } finally {
    await view.close();
    mock.timers.reset();
  }
});
