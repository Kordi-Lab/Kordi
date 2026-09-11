import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import { canonicalRendererMessageIds, compactNativeCloudMessagesByPeer, estimateCloudMessageBytes } from '../src/features/cloud/cloudRendererRetention';
import type { CanonicalSessionMessage } from '../src/kordi-app/types';
import { useCloudCollaborationMessageStore } from '../src/features/cloud/useCloudCollaborationMessageStore';
import { createCloudMessageIndexer } from '../src/features/cloud/cloudMessageIndexer';
import { parseCloudGroupControl } from '../src/features/cloud/cloudGroupMessages';
import { buildScaleCloudMessagesByPeer, SCALE_ACCOUNT_ID } from './fixtures/chatScale';

function message(index: number, sessionId = 'active'): CloudMessage {
  return {
    messageId: `message-${index}`, fromAccountId: 'peer', toAccountId: 'account',
    body: `Message ${index}`, createdAt: new Date(index * 1000).toISOString(),
    deliveredAt: new Date(index * 1000).toISOString(), readAt: null, direction: 'incoming',
    sessionId, conversationSequence: index + 1,
  };
}

test('active sessions have a bounded compatibility tail while canonical history remains paged separately', () => {
  const input = { peer: Array.from({ length: 2_000 }, (_, index) => message(index)) };
  const result = compactNativeCloudMessagesByPeer(input, 64, 'active');
  assert.equal(result.peer.length, 64);
  assert.equal(compactNativeCloudMessagesByPeer(input, 64, 'active'), result);
  assert.equal(compactNativeCloudMessagesByPeer(result, 64, 'active'), result);
  assert.equal(result.peer.at(-1), input.peer.at(-1));
  assert.equal(compactNativeCloudMessagesByPeer(input, 0).peer.length, 1);
});

test('aggregate payload and row budgets bound disposable history without dropping correctness pins', () => {
  const messages = Array.from({ length: 100 }, (_, index) => ({ ...message(index), body: 'x'.repeat(4_096) }));
  const pending = { ...message(-1), messageId: 'pending', direction: 'outgoing' as const, deliveredAt: null };
  const route = { ...message(-2), messageId: 'route', messageKind: 'agent-model-change' };
  const input = { peer: [route, pending, ...messages] };
  const maxBytes = 40_000;
  const result = compactNativeCloudMessagesByPeer(input, 64, 'active', { maxRows: 5, maxBytes });
  assert.ok(result.peer.length <= 5);
  assert.ok(result.peer.reduce((sum, row) => sum + estimateCloudMessageBytes(row), 0) <= maxBytes);
  assert.ok(result.peer.includes(pending));
  assert.ok(result.peer.includes(route));
  assert.ok(result.peer.includes(messages.at(-1)!));
  const onlyPins = compactNativeCloudMessagesByPeer(input, 64, 'active', { maxRows: 0, maxBytes: 0 });
  assert.equal(onlyPins.peer.length, 3, 'pins are an explicit budget floor, never silently discarded');
});

test('the account indexer reuses unchanged envelopes and does not retain evicted rows', () => {
  const rows = buildScaleCloudMessagesByPeer().acct_scale_0.slice(0, 10);
  let parsed = 0;
  const indexMessages = createCloudMessageIndexer(SCALE_ACCOUNT_ID, {
    parseGroupControl(body) { parsed += 1; return parseCloudGroupControl(body); },
  });
  const first = indexMessages({ peer: rows });
  assert.equal(parsed, 10);
  const next = indexMessages({ peer: rows.slice(1) });
  assert.equal(parsed, 10);
  assert.equal(next.groupRows[0], first.groupRows[1]);
  assert.equal(next.byMessageId.has(rows[0].messageId), false);
  assert.equal(next.sourceMessagesByPeer.peer.length, 9);
  assert.equal(indexMessages(next.sourceMessagesByPeer), next);
});

test('updates to an older loaded canonical page survive compatibility eviction', () => {
  const required = canonicalRendererMessageIds([{
    id: 'canonical-old', sourceTransport: 'cloud-group', sourceEventId: 'cloud-group:wire-old:2',
  } as CanonicalSessionMessage]);
  const edited = { ...message(0), messageId: 'wire-old', version: 3, body: 'Edited older message' };
  const input = { peer: [edited, ...Array.from({ length: 100 }, (_, index) => message(index + 1))] };
  const retained = compactNativeCloudMessagesByPeer(input, 64, 'active', undefined, required);
  assert.ok(retained.peer.includes(edited));
  assert.equal(retained.peer.length, 65);
  assert.equal(compactNativeCloudMessagesByPeer(retained).peer.includes(edited), false, 'unloaded pages release the pin');
});

test('native recovery releases backing references and repeated updates/chat switches stay bounded', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const previous = { window: globalThis.window, document: globalThis.document,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  let store!: ReturnType<typeof useCloudCollaborationMessageStore>;
  function Harness({ accountId = 'account', active = 'active' }) {
    store = useCloudCollaborationMessageStore({ accountId } as CloudAccount, active);
    return null;
  }
  const root = createRoot(document.getElementById('root')!);
  try {
    await act(async () => root.render(createElement(Harness)));
    await act(async () => store.setValue({ peer: Array.from({ length: 1_000 }, (_, index) => message(index)) }));
    await act(async () => store.onGroupRecoverySettled());
    assert.equal(store.valueRef.current.peer.length, 1_000, 'recovery still needs the initial rows');
    await act(async () => store.onSelfAgentRecoverySettled());
    assert.equal(store.valueRef.current.peer.length, 64);
    assert.equal(store.fullCurrentAccountValue, store.valueRef.current);
    assert.equal(store.value, store.valueRef.current);
    for (let round = 0; round < 12; round += 1) {
      await act(async () => root.render(createElement(Harness, { active: round % 2 ? 'other' : 'active' })));
      await act(async () => store.setValue((current) => ({
        peer: [...current.peer, ...Array.from({ length: 100 }, (_, index) => message(1_000 + round * 100 + index))],
      })));
      assert.equal(store.valueRef.current.peer.length, 64);
      assert.equal(store.fullCurrentAccountValue, store.valueRef.current);
      assert.equal(store.index.allMessages.length, 64);
    }
    const oldestKept = store.valueRef.current.peer[0];
    await act(async () => store.setValue((current) => ({ peer: current.peer.filter((row) => row !== oldestKept) })));
    assert.equal(store.index.byMessageId.has(oldestKept.messageId), false);
    const staleSetValue = store.setValue;
    await act(async () => root.render(createElement(Harness, { accountId: 'second-account' })));
    assert.deepEqual(store.valueRef.current, {});
    assert.deepEqual(store.currentAccountValue, {});
    assert.deepEqual(store.fullCurrentAccountValue, {});
    assert.equal(store.index.allMessages.length, 0);
    await act(async () => staleSetValue({ peer: [oldestKept] }));
    assert.deepEqual(store.valueRef.current, {}, 'late callbacks cannot restore the previous account');
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});
