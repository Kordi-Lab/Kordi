import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import type { CloudAccount, CloudAuthClient } from '../src/features/cloud/authClient';
import { __setSessionBackendForTests } from '../src/features/cloud/session';
import { useCloudRealtimeMessages } from '../src/features/cloud/useCloudRealtimeMessages';
import { useCloudRepairPolling } from '../src/features/cloud/useCloudRepairPolling';

test('realtime and repair polling preserve background delivery, account isolation, and timer cleanup', async (context) => {
  const dom = new JSDOM('<div id="root"></div>');
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    WebSocket: globalThis.WebSocket,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  let now = 0;
  context.mock.method(Date, 'now', () => now);
  let nextTimer = 0;
  const intervals = new Map<number, { callback: () => void; ms: number }>();
  const timeouts = new Map<number, { callback: () => void; ms: number }>();
  context.mock.method(window, 'setInterval', (callback: () => void, ms: number) => {
    intervals.set(++nextTimer, { callback, ms });
    return nextTimer;
  });
  context.mock.method(window, 'clearInterval', (id: number) => { intervals.delete(id); });
  context.mock.method(window, 'setTimeout', (callback: () => void, ms: number) => {
    timeouts.set(++nextTimer, { callback, ms });
    return nextTimer;
  });
  context.mock.method(window, 'clearTimeout', (id: number) => { timeouts.delete(id); });
  class Socket {
    static OPEN = 1;
    static instances: Socket[] = [];
    readyState = 1;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { Socket.instances.push(this); }
    send() {}
    close() { this.readyState = 3; this.onclose?.(); }
    hello() { this.onopen?.(); this.onmessage?.({ data: JSON.stringify({ type: 'hello' }) }); }
  }
  Object.assign(globalThis, { WebSocket: Socket });
  let activeAccountId = 'fixture-account';
  mockIPC((command) => {
    assert.equal(command, 'desktop_chat_sync_cursor');
    return { accountId: activeAccountId, cursor: 'fixture-cursor', lastStreamSeq: 1 };
  });
  __setSessionBackendForTests({
    load: async () => ({ token: 'fixture-token', accountId: activeAccountId, expiresAt: '2099-01-01T00:00:00Z' }),
    save: async () => {},
    clear: async () => {},
  });
  let syncs = 0;
  let warnings = 0;
  const sync = async () => { syncs += 1; };
  const reportWarning = () => { warnings += 1; };
  const client = {
    issueChatSyncRealtimeTicket: async () => ({ ticket: 'fixture-ticket', device_id: 'fixture-device' }),
  } as unknown as CloudAuthClient;
  function Harness({ account }: { account: CloudAccount }) {
    const setRealtimeConnected = useCloudRepairPolling(account.accountId, true, sync);
    useCloudRealtimeMessages({ account, client, mergeMessage: () => {}, syncCloudCollaborationDiff: sync, setRealtimeConnected, reportWarning });
    return null;
  }
  const account = { accountId: activeAccountId, displayName: 'Fixture' } as CloudAccount;
  const root = createRoot(document.getElementById('root')!);
  let unmounted = false;
  const tick = async (ms: number) => {
    now = ms;
    await act(async () => {
      for (const timer of intervals.values()) if (timer.ms === 15_000) timer.callback();
    });
  };
  try {
    assert.equal(document.visibilityState, 'hidden');
    await act(async () => root.render(createElement(Harness, { account })));
    assert.equal(Socket.instances.length, 1);
    const socket = Socket.instances[0];
    await act(async () => socket.hello());
    const startupSyncs = syncs;
    await tick(15_000);
    await tick(30_000);
    await tick(45_000);
    assert.equal(syncs, startupSyncs);
    await tick(60_000);
    assert.equal(syncs, startupSyncs + 1);
    await act(async () => socket.onmessage?.({ data: JSON.stringify({ type: 'event', stream_seq: 2 }) }));
    assert.equal(syncs, startupSyncs + 2, 'hidden realtime events must still sync immediately');
    await act(async () => root.render(createElement(Harness, { account: { ...account, displayName: 'Updated profile' } })));
    assert.equal(Socket.instances.length, 1, 'profile edits must not reopen the socket');
    await act(async () => socket.close());
    await tick(75_000);
    assert.equal(syncs, startupSyncs + 3, 'closed sockets must restore fallback polling');
    const reconnect = [...timeouts].find(([, timer]) => timer.ms === 1_000)!;
    timeouts.delete(reconnect[0]);
    await act(async () => reconnect[1].callback());
    assert.equal(Socket.instances.length, 2);
    await act(async () => Socket.instances[1].hello());
    activeAccountId = 'second-fixture-account';
    __setSessionBackendForTests({
      load: async () => ({ token: 'second-fixture-token', accountId: activeAccountId, expiresAt: '2099-01-01T00:00:00Z' }),
      save: async () => {}, clear: async () => {},
    });
    await act(async () => root.render(createElement(Harness, { account: { ...account, accountId: activeAccountId } })));
    assert.equal(Socket.instances.length, 3);
    assert.equal(Socket.instances[1].readyState, 3);
    const beforeLateHello = syncs;
    await act(async () => Socket.instances[1].hello());
    await tick(90_000);
    assert.equal(syncs, beforeLateHello + 1, 'a stale hello must not suppress the new account fallback');
    await act(async () => root.unmount());
    unmounted = true;
    assert.equal(intervals.size, 0);
    assert.equal(timeouts.size, 0);
    assert.equal(Socket.instances[2].readyState, 3);
    assert.equal(warnings, 0);
  } finally {
    if (!unmounted) await act(async () => root.unmount());
    clearMocks();
    __setSessionBackendForTests(null);
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});
