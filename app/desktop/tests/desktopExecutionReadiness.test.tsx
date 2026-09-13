import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useDesktopAuthState } from '../src/features/auth/useDesktopAuthState';
import { useCloudMessageSync, type CloudMessageSyncController, type CloudMessageSyncStores } from '../src/features/cloud/useCloudMessageSync';
import { CloudSyncCoordinator } from '../src/features/cloud/cloudSyncCoordinator';
import { cloudUnreadReadinessContextKey, type CloudUnreadReadinessSnapshot } from '../src/features/cloud/cloudMessageSyncState';
import { EMPTY_CLOUD_SESSION_ACTIVITY } from '../src/features/cloud/cloudSessionActivity';
import { useDesktopAgentReadiness } from '../src/features/cloud/useDesktopAgentReadiness';
import { CloudAuthClient, type CloudAccount } from '../src/features/cloud/authClient';
import { __setSessionBackendForTests, CLOUD_SESSION_CHANGED_EVENT } from '../src/features/cloud/session';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  assert(predicate(), 'Expected asynchronous state transition');
}

async function fixture(invoke: (command: string) => Promise<unknown>) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const replacements = { window: dom.window, document: dom.window.document, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  Object.assign(dom.window, { __TAURI_INTERNALS__: { invoke } });
  let accountId = 'acct_test';
  __setSessionBackendForTests({ load: async () => ({ accountId, token: 'synthetic', expiresAt: '2099-01-01' }), save: async () => {}, clear: async () => {} });
  const root = createRoot(document.getElementById('root')!);
  return {
    dom,
    setAccount(value: string) {
      accountId = value;
      __setSessionBackendForTests({ load: async () => ({ accountId, token: 'synthetic', expiresAt: '2099-01-01' }), save: async () => {}, clear: async () => {} });
    },
    async render(content: React.ReactNode) { await act(async () => root.render(content)); },
    async close() {
      await act(async () => root.unmount());
      __setSessionBackendForTests(null);
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      dom.window.close();
    },
  };
}

test('same-account session refresh reloads auth without needing focus and rejects superseded reads', async () => {
  const reads: ReturnType<typeof deferred<unknown>>[] = [];
  const view = await fixture(async command => {
    assert.equal(command, 'desktop_auth_state');
    const read = deferred<unknown>();
    reads.push(read);
    return read.promise;
  });
  let state: ReturnType<typeof useDesktopAuthState>;
  function Probe() {
    state = useDesktopAuthState({ isNativeShell: true, accountId: 'acct_test' });
    return null;
  }
  try {
    await view.render(<Probe />);
    await waitFor(() => reads.length === 1);
    await act(async () => reads[0].resolve({ marker: 'initial' }));
    assert.deepEqual(state!.desktopAuthState, { marker: 'initial' });
    await act(async () => view.dom.window.dispatchEvent(new view.dom.window.Event(CLOUD_SESSION_CHANGED_EVENT)));
    await waitFor(() => reads.length === 2);
    assert.equal(state!.desktopAuthState, null);
    assert.equal(state!.isDesktopAuthLoading, true);
    await act(async () => view.dom.window.dispatchEvent(new view.dom.window.Event(CLOUD_SESSION_CHANGED_EVENT)));
    await waitFor(() => reads.length === 3);
    await act(async () => reads[2].resolve({ marker: 'current' }));
    await act(async () => reads[1].resolve({ marker: 'stale' }));
    assert.deepEqual(state!.desktopAuthState, { marker: 'current' });
    assert.equal(state!.isDesktopAuthLoading, false);
  } finally { await view.close(); }
});

test('execution waits for capability acknowledgement and ignores stale account responses', async () => {
  const view = await fixture(async () => null);
  const requests: { input: unknown; done: ReturnType<typeof deferred<unknown>> }[] = [];
  const client = new CloudAuthClient('http://localhost');
  client.desktopAgentExecution = async <T,>(_token: string, action: string, input: unknown): Promise<T> => {
    assert.equal(action, 'ready');
    const done = deferred<unknown>();
    requests.push({ input, done });
    return await done.promise as T;
  };
  const reportWarning = () => {};
  let ready = false;
  function Probe({ accountId, runtimeReady = true }: { accountId: string; runtimeReady?: boolean }) {
    ready = useDesktopAgentReadiness({ account: { accountId } as CloudAccount, client, runtimeReady, reportWarning });
    return null;
  }
  try {
    await view.render(<Probe accountId="acct_test" />);
    await waitFor(() => requests.length === 1);
    assert.equal(ready, false);
    view.setAccount('acct_other');
    await view.render(<Probe accountId="acct_other" />);
    assert.equal(requests.length, 1, "Capability replacements must remain ordered");
    await act(async () => requests[0].done.resolve({}));
    await waitFor(() => requests.length === 2);
    assert.equal(ready, false);
    await act(async () => requests[1].done.resolve({}));
    assert.equal(ready, true);
    await view.render(<Probe accountId="acct_other" runtimeReady={false} />);
    assert.equal(ready, false);
    await waitFor(() => requests.length === 3);
    assert.deepEqual(requests[2].input, { agentIds: [] });
    // Restoring the same capability list must obtain a fresh acknowledgement,
    // even while its withdrawal is still in flight.
    await view.render(<Probe accountId="acct_other" />);
    assert.equal(ready, false);
    assert.equal(requests.length, 3);
    await act(async () => requests[2].done.resolve({}));
    await waitFor(() => requests.length === 4);
    assert.equal(ready, false);
    await act(async () => requests[3].done.resolve({}));
    assert.equal(ready, true);
  } finally { await view.close(); }
});


test('live execution becomes ready after cursor catch-up while older history remains blocked', async () => {
  const view = await fixture(async command => {
    if (command === 'desktop_chat_sync_load' || command === 'desktop_chat_sync_cursor') return null;
    if (command === 'desktop_chat_sync_apply') return { changedConversationHeads: [] };
    if (command === 'desktop_chat_sync_conversations') return [{ id: 'conversation', latest_message_sequence: 1 }];
    if (command === 'desktop_chat_sync_coverage') return [];
    throw new Error(`Unexpected native command: ${command}`);
  });
  const client = new CloudAuthClient('http://localhost');
  const coordinator = new CloudSyncCoordinator();
  const cursor = deferred<Awaited<ReturnType<CloudAuthClient['syncCloudEvents']>>>();
  const history = deferred<void>();
  let historyStarted = false;
  client.drainChatOutbox = async () => {};
  client.syncCloudEvents = async () => cursor.promise;
  client.listChatConversationHistoryPage = async () => {
    historyStarted = true;
    await history.promise;
    throw new Error('Synthetic history unavailable');
  };
  function store<T>(initial: T) {
    const stateRef = { current: initial };
    return { stateRef, setState: (update: React.SetStateAction<T>) => {
      stateRef.current = typeof update === 'function' ? (update as (value: T) => T)(stateRef.current) : update;
    } };
  }
  const stores: CloudMessageSyncStores = {
    messages: { ...store({}), peerReadAtByPeerRef: { current: {} } },
    activity: store(EMPTY_CLOUD_SESSION_ACTIVITY), forks: store({}), pins: store({}), titles: store({}), agents: store({}),
    hiddenSessionIds: store(new Set<string>()), deletedSessionIds: store(new Set<string>()),
    unreadSessionIds: store(new Set<string>()), pinnedSessionIds: store(new Set<string>()),
    mutedSessionIds: store(new Set<string>()), pinnedGroupSpaceIds: store(new Set<string>()),
  };
  let unread: CloudUnreadReadinessSnapshot = { status: 'pending', contextKey: null };
  const setUnreadReadiness = (update: React.SetStateAction<CloudUnreadReadinessSnapshot>) => {
    unread = typeof update === 'function' ? update(unread) : update;
  };
  const refreshCloudAgents = async () => {};
  const cancelledRef = { current: false };
  let state: CloudMessageSyncController;
  function Probe({ accountId }: { accountId: string }) {
    state = useCloudMessageSync({ account: { accountId } as CloudAccount, client, coordinator,
      bootstrapPeerIds: [accountId], bootstrapPeerKey: accountId, contactsSettled: true,
      cloudUnreadContextKey: cloudUnreadReadinessContextKey(accountId, coordinator.currentGeneration(), accountId),
      cancelledRef, stores, setUnreadReadiness, refreshCloudAgents });
    return null;
  }
  try {
    await view.render(<Probe accountId="acct_test" />);
    assert.equal(state!.executionMessagesReady, false);
    await act(async () => cursor.resolve({ cursor: '1', events: [], hasMore: false,
      chat: { bootstrap: true, nextCursor: '1', lastStreamSeq: 1, conversations: [], messages: [], events: [] },
    } as unknown as Awaited<ReturnType<CloudAuthClient['syncCloudEvents']>>));
    await waitFor(() => historyStarted && state!.executionMessagesReady);
    assert.equal(unread.status, 'pending', 'Unread counts still wait for complete historical coverage');
    await act(async () => history.resolve());
    assert.equal(unread.status, 'error');
    assert.equal(state!.executionMessagesReady, true, 'Unavailable old history cannot disable fresh request admission');
    coordinator.changeAccount();
    const nextCursor = deferred<Awaited<ReturnType<CloudAuthClient['syncCloudEvents']>>>();
    client.syncCloudEvents = async () => nextCursor.promise;
    view.setAccount('acct_other');
    await view.render(<Probe accountId="acct_other" />);
    // A new account must pass its own cursor boundary; the old readiness key
    // is never accepted merely because it shared the same sync coordinator.
    assert.equal(state!.executionMessagesReady, false);
    assert.notEqual(unread.contextKey, cloudUnreadReadinessContextKey('acct_test', 0, 'acct_test'));
    cancelledRef.current = true;
    await act(async () => nextCursor.resolve(await cursor.promise));
  } finally { cancelledRef.current = true; await view.close(); }
});
