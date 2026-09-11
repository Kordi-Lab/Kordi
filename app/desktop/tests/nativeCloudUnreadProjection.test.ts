import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cloudOptimisticReadSequences, createNativeCloudUnreadProjection } from '../src/features/cloud/nativeCloudUnreadProjection';
import type { CloudMessage } from '../src/features/cloud/authClient';
import type { CloudAccount } from '../src/features/cloud/authClient';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { useCloudCanonicalReconciliation } from '../src/features/cloud/useCloudCanonicalReconciliation';
import { buildCloudMessageIndex } from '../src/features/cloud/cloudMessageIndex';
import { CHAT_SYNC_LOCAL_STATE_CHANGED_EVENT } from '../src/lib/desktopChatSync';

test('durable unread totals survive eviction of the entire renderer history', () => {
  const project = createNativeCloudUnreadProjection('account');
  const heads = { session: { latestMessageSequence: 1_000, lastReadSequence: 100, unreadCount: 900 } };
  assert.deepEqual(project('account', heads, new Set(), {}), { session: 900 });
  assert.deepEqual(project('account', heads, new Set(), { session: 50 }), { session: 900 });
  assert.deepEqual(project('account', heads, new Set(), { session: 1_000 }), { session: 0 });
  assert.deepEqual(project('account', { session: { ...heads.session, latestMessageSequence: 1_001, unreadCount: 901 } }, new Set(), { session: 1_000 }), { session: 901 });
});

test('explicit optimistic reads cover one head and do not hide later arrivals or another account', () => {
  const project = createNativeCloudUnreadProjection('account');
  const heads = { session: { latestMessageSequence: 10, lastReadSequence: 5, unreadCount: 5 } };
  const local = new Set(['session']);
  assert.deepEqual(project('account', heads, local, {}), { session: 0 });
  const next = { session: { ...heads.session, latestMessageSequence: 11, unreadCount: 6 } };
  assert.deepEqual(project('account', next, local, {}), { session: 6 });
  assert.equal(project('different-account', next, local, {}), null);
  assert.deepEqual(project('account', next, new Set(), {}), { session: 6 });
  assert.deepEqual(project('account', next, local, {}), { session: 0 });
});

test('read sequence extraction ignores missing, unsent, and evicted messages', () => {
  const rows = [{ messageId: 'old', sessionId: 'session', conversationSequence: 4 },
    { messageId: 'read', sessionId: 'session', conversationSequence: 8 },
    { messageId: 'new', sessionId: 'session', conversationSequence: 9 },
    { messageId: 'pending', sessionId: 'session' }] as CloudMessage[];
  assert.deepEqual(cloudOptimisticReadSequences({ peer: rows }, {
    peer: new Set(['old', 'read', 'pending', 'evicted']),
  }), { session: 8 });
});

test('the native reconciliation hook reads durable totals and rejects stale optimistic coverage', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const previous = { window: globalThis.window, document: globalThis.document,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  let head = { conversationId: 'conversation', sessionId: 'session', latestMessageSequence: 1_000, lastReadSequence: 100, unreadCount: 900 };
  mockIPC((command) => { assert.equal(command, 'desktop_chat_sync_unread_counts'); return [head]; });
  const account = { accountId: 'account' } as CloudAccount;
  const rows: CloudMessage[] = [{ messageId: 'latest', sessionId: 'session', conversationSequence: 1_000,
    fromAccountId: 'peer', toAccountId: 'account', body: 'Latest', direction: 'incoming', readAt: null,
    createdAt: '2026-01-01T00:00:00Z', deliveredAt: '2026-01-01T00:00:00Z' }];
  const byPeer = { peer: rows };
  const index = buildCloudMessageIndex(account.accountId, byPeer);
  const local = new Set<string>();
  let readIds = { peer: new Set<string>() };
  let result: Record<string, number> | null = null;
  const noop = () => {};
  function Harness() {
    result = useCloudCanonicalReconciliation({ account, canonical: { state: null },
      messages: { fullByPeer: byPeer, index, authoritative: true },
      unread: { contextKey: 'fixture', locallyReadSessionIds: local, readInboundMessageIdsByPeer: readIds,
        setLocallyReadSessionIds: noop, setPublishedContextKey: noop } });
    return null;
  }
  const root = createRoot(document.getElementById('root')!);
  try {
    await act(async () => root.render(createElement(Harness)));
    assert.deepEqual(result, { session: 900 }, 'one retained row must not replace the durable unread total');
    readIds = { peer: new Set(['latest']) };
    await act(async () => root.render(createElement(Harness)));
    assert.deepEqual(result, { session: 0 });
    head = { ...head, latestMessageSequence: 1_001, unreadCount: 901 };
    await act(async () => window.dispatchEvent(new dom.window.Event(CHAT_SYNC_LOCAL_STATE_CHANGED_EVENT)));
    assert.deepEqual(result, { session: 901 });
  } finally {
    await act(async () => root.unmount());
    clearMocks(); Object.assign(globalThis, previous); dom.window.close();
  }
});
