import { waitForReactCondition } from './helpers/waitForReactCondition';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import type { CloudAccount, CloudAuthClient } from '../src/features/cloud/authClient';
import type { ChatSyncConversation, ChatSyncMessage } from '../src/features/cloud/chatSyncTypes';
import { cloudCollaborationConversationId, cloudDirectPersonSessionId } from '../src/features/collaboration/conversationIds';
import { directHistorySessionId, readDirectCloudHistoryPage, useCloudDirectHistory } from '../src/features/cloud/useCloudDirectHistory';
import { useCloudCollaborationMessageStore } from '../src/features/cloud/useCloudCollaborationMessageStore';
import { __setSessionBackendForTests } from '../src/features/cloud/session';

const account = { accountId: 'acct_me' } as CloudAccount;
const sessionId = cloudDirectPersonSessionId(account.accountId, 'acct_peer');
const conversation: ChatSyncConversation = {
  id: 'direct-conversation', kind: 'direct', shared_title: null, version: 1,
  created_by_account_id: account.accountId, legacy_session_id: sessionId, latest_message_sequence: 120,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:02:00Z',
  members: ['acct_me', 'acct_peer'].map((id) => ({ account_id: id, role: 'member', membership_state: 'active',
    version: 1, last_delivered_sequence: 120, last_read_sequence: 0, joined_at: '2026-01-01T00:00:00Z', left_at: null })),
  preferences: { conversation_id: 'direct-conversation', account_id: account.accountId, personal_title: null, version: 1 },
};
const messages: ChatSyncMessage[] = Array.from({ length: 120 }, (_, index) => ({
  id: `message-${index + 1}`, client_message_id: `client-${index + 1}`, conversation_id: conversation.id,
  conversation_sequence: index + 1, sender_account_id: 'acct_peer', kind: 'message',
  content: { schema: 1, blocks: [{ type: 'text', text: `Earlier message ${index + 1}` }] },
  reply_to_message_id: null, attachment_ids: [], version: 1, generation_status: null, provider_response_id: null,
  created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index + 1)).toISOString(), edited_at: null, deleted_at: null,
}));

function setupNative(gapped = false, delayRead?: () => Promise<void>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  if (!globalThis.window) Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  let reads = 0;
  let persisted = 0;
  mockIPC((command, payload) => {
    if (command === 'desktop_chat_sync_conversations') return [conversation];
    if (command === 'desktop_chat_sync_coverage') return [{ conversationId: conversation.id, earliestSequence: 1,
      latestSequence: 120, messageCount: gapped ? 119 : 120 }];
    if (command === 'desktop_chat_sync_messages_page') {
      reads += 1;
      const rows = messages.filter((row) => row.conversation_sequence > Number(payload?.afterSequence ?? 0)).slice(0, Number(payload?.limit));
      const result = { conversationId: conversation.id, messages: rows, nextAfterSequence: rows.at(-1)?.conversation_sequence ?? null, hasMore: false };
      return delayRead ? delayRead().then(() => result) : result;
    }
    if (command === 'desktop_chat_sync_apply') { persisted += 1; return { changedConversationHeads: [] }; }
    throw new Error(`Unexpected native command: ${command}`);
  });
  return { reads: () => reads, persisted: () => persisted, restore() {
    clearMocks();
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else delete (globalThis as { window?: unknown }).window;
  } };
}

test('person contact and canonical routes resolve to the same direct history; agent and group routes do not', () => {
  assert.equal(directHistorySessionId(account.accountId, cloudCollaborationConversationId('acct_peer')), sessionId);
  assert.equal(directHistorySessionId(account.accountId, sessionId), sessionId);
  assert.equal(directHistorySessionId(account.accountId, cloudCollaborationConversationId('acct_peer', 'agent')), null);
  assert.equal(directHistorySessionId(account.accountId, cloudCollaborationConversationId('acct_peer', 'person', 'session:group:one')), null);
});

test('complete native direct history pages backwards without canonical rows or a network request', async () => {
  const native = setupNative();
  const client = { listChatConversationHistoryPage: async () => { throw new Error('Must use durable local history'); } } as unknown as CloudAuthClient;
  try {
    const first = await readDirectCloudHistoryPage(account.accountId, sessionId, client);
    assert.equal(first?.messagesByPeer.acct_peer.length, 50);
    assert.equal(first?.beforeSequence, 71);
    const second = await readDirectCloudHistoryPage(account.accountId, sessionId, client, first!.beforeSequence!);
    assert.equal(second?.messagesByPeer.acct_peer.length, 50);
    assert.equal(second?.beforeSequence, 21);
    const last = await readDirectCloudHistoryPage(account.accountId, sessionId, client, second!.beforeSequence!);
    assert.equal(last?.messagesByPeer.acct_peer.length, 20);
    assert.equal(last?.hasOlder, false);
    assert.equal(native.reads(), 3);
  } finally { native.restore(); }
});

test('direct history overlays the latest-only preview and releases loaded pages on chat switches', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const previous = { window: globalThis.window, document: globalThis.document,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const native = setupNative();
  const client = {} as CloudAuthClient;
  let history!: ReturnType<typeof useCloudDirectHistory>;
  let store!: ReturnType<typeof useCloudCollaborationMessageStore>;
  function Harness({ active = cloudCollaborationConversationId('acct_peer') }) {
    history = useCloudDirectHistory(account, active, client);
    store = useCloudCollaborationMessageStore(account, active, undefined, history.page);
    return null;
  }
  const root = createRoot(document.getElementById('root')!);
  try {
    await act(async () => root.render(createElement(Harness)));
    await waitForReactCondition(() => history.page?.messagesByPeer.acct_peer.length === 50, 'initial direct page must finish before inspection');
    await act(async () => store.setValue({}));
    assert.equal(store.index.allMessages.length, 50);
    assert.equal(history.hasOlderBySessionId[sessionId], true);
    await act(async () => Promise.all([history.loadOlderSessionMessages(sessionId), history.loadOlderSessionMessages(sessionId)]));
    assert.equal(store.index.allMessages.length, 100);
    await act(async () => history.loadOlderSessionMessages(sessionId));
    assert.equal(store.index.allMessages.length, 120);
    assert.equal(history.hasOlderBySessionId[sessionId], false);
    assert.equal(native.reads(), 3);
    await act(async () => root.render(createElement(Harness, { active: 'session:group:other' })));
    assert.equal(history.page, null);
    assert.equal(store.index.allMessages.length, 0);
  } finally {
    await act(async () => root.unmount()); native.restore(); Object.assign(globalThis, previous); dom.window.close();
  }
});

test('gapped native coverage falls back to one server page and persists it locally', async () => {
  const dom = new JSDOM('<div></div>');
  const previousWindow = globalThis.window;
  const previousEvent = globalThis.Event;
  Object.assign(globalThis, { window: dom.window, Event: dom.window.Event });
  const native = setupNative(true);
  __setSessionBackendForTests({ load: async () => ({ accountId: account.accountId, token: 'fixture', expiresAt: '2099-01-01T00:00:00Z' }), save: async () => {}, clear: async () => {} });
  let requests = 0;
  const client = { listChatConversationHistoryPage: async (_token: string, id: string, before: number | undefined, limit: number) => {
    requests += 1; assert.equal(id, conversation.id); assert.equal(before, undefined); assert.equal(limit, 50);
    return { messages: messages.slice(-50), nextBeforeSequence: 71, hasMore: true };
  } } as unknown as CloudAuthClient;
  try {
    const page = await readDirectCloudHistoryPage(account.accountId, sessionId, client);
    assert.equal(page?.messagesByPeer.acct_peer.length, 50);
    assert.equal(requests, 1); assert.equal(native.persisted(), 1); assert.equal(native.reads(), 0);
  } finally { __setSessionBackendForTests(null); native.restore(); Object.assign(globalThis, { window: previousWindow, Event: previousEvent }); dom.window.close(); }
});


test('switching away and back rejects an earlier direct-history flight', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const previous = { window: globalThis.window, document: globalThis.document,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  let finishFirst!: () => void;
  let calls = 0;
  const native = setupNative(false, () => ++calls === 1 ? new Promise<void>(resolve => { finishFirst = resolve; }) : Promise.resolve());
  let history!: ReturnType<typeof useCloudDirectHistory>;
  const client = {} as CloudAuthClient;
  function Harness({ active }: { active: string }) { history = useCloudDirectHistory(account, active, client); return null; }
  const root = createRoot(document.getElementById('root')!);
  const active = cloudCollaborationConversationId('acct_peer');
  try {
    await act(async () => root.render(createElement(Harness, { active })));
    await waitForReactCondition(() => calls === 1, 'first request must be in flight');
    await act(async () => root.render(createElement(Harness, { active: 'session:group:other' })));
    await act(async () => root.render(createElement(Harness, { active })));
    await waitForReactCondition(() => calls === 2 && Boolean(history.page), 'returning to the chat starts a new scoped request');
    const accepted = history.page;
    await act(async () => { finishFirst(); await new Promise<void>(resolve => setImmediate(resolve)); });
    assert.strictEqual(history.page, accepted, 'an old visit must not replace the new visit');
  } finally {
    finishFirst?.(); await act(async () => root.unmount()); native.restore(); Object.assign(globalThis, previous); dom.window.close();
  }
});
