import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { CloudAccount, CloudAuthClient, CloudMessage } from '../src/features/cloud/authClient';
import { cloudCollaborationConversationId, cloudDirectPersonSessionId } from '../src/features/collaboration/conversationIds';
import { buildCloudMessageIndex } from '../src/features/cloud/cloudMessageIndex';
import { useCloudMessageReadReceipts } from '../src/features/cloud/useCloudMessageReadReceipts';
import { __setSessionBackendForTests } from '../src/features/cloud/session';
import { cloudOptimisticallyReadSessionIds, cloudUnreadCountsBySessionId, mergeNativeCloudUnreadCounts } from '../src/features/cloud/cloudUnreadReconciliation';
import { SidebarUnreadBadge } from '../src/pages/workspaceSidebar.shared';

const account = { accountId: 'acct_me' } as CloudAccount;
const peerId = 'acct_peer';
const sessionId = cloudDirectPersonSessionId(account.accountId, peerId);
const incoming: CloudMessage = {
  messageId: 'direct-1', fromAccountId: peerId, toAccountId: account.accountId,
  body: 'Synthetic direct message', sessionId, conversationId: 'conversation-direct',
  conversationSequence: 1, direction: 'incoming', createdAt: '2026-09-10T10:00:00Z',
  deliveredAt: null, readAt: null,
};

async function mount(activeId = cloudCollaborationConversationId(peerId, 'person')) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const values = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  __setSessionBackendForTests({
    load: async () => ({ token: 'test-token', accountId: account.accountId, expiresAt: '2099-01-01T00:00:00Z' }),
    save: async () => {}, clear: async () => {},
  });
  const requests: Array<{ sessionId: string; resolve: () => void; reject: () => void }> = [];
  const client = {
    markSessionMessagesRead: (_token: string, target: string) => new Promise<void>((resolve, reject) => {
      requests.push({ sessionId: target, resolve, reject: () => reject(new Error('Synthetic read failure')) });
    }),
  } as unknown as CloudAuthClient;
  const sync = async () => {};
  const host = document.getElementById('root')!;
  const root = createRoot(host);
  let setMessages!: React.Dispatch<React.SetStateAction<Record<string, CloudMessage[]>>>;
  let setReadIds!: React.Dispatch<React.SetStateAction<Record<string, Set<string>>>>;
  let currentMessages: Record<string, CloudMessage[]> = {};
  let readIds: Record<string, Set<string>> = {};
  let props = { activeId, presented: false, account };
  function Harness(input: typeof props) {
    const [messages, updateMessages] = useState({ [peerId]: [incoming] });
    const [ids, setIds] = useState<Record<string, Set<string>>>({});
    setMessages = updateMessages;
    setReadIds = setIds;
    currentMessages = messages;
    readIds = ids;
    const index = useMemo(() => buildCloudMessageIndex(input.account.accountId, messages), [input.account.accountId, messages]);
    useCloudMessageReadReceipts({
      account: input.account, activeConversationId: input.activeId,
      canMarkActiveConversationRead: input.presented, client, canonical: {},
      messages: { index, setByPeer: updateMessages, sync }, setReadInboundMessageIdsByPeer: setIds,
    });
    const projected = cloudUnreadCountsBySessionId({ accountId: input.account.accountId, messagesByPeer: messages, readInboundMessageIdsByPeer: ids });
    const optimistic = cloudOptimisticallyReadSessionIds({ messagesByPeer: messages, readInboundMessageIdsByPeer: ids });
    const counts = mergeNativeCloudUnreadCounts({
      nativeHeadsBySessionId: { [sessionId]: { lastReadSequence: 0, unreadCount: 1 } },
      optimisticSessionIds: optimistic, projectedUnreadBySessionId: projected,
    });
    return <SidebarUnreadBadge scope="direct" count={counts[sessionId]} />;
  }
  const render = async (next: Partial<typeof props> = {}) => {
    props = { ...props, ...next };
    await act(async () => { root.render(<Harness {...props} />); });
  };
  await render();
  return {
    host, requests, render, ids: () => readIds,
    messages: () => currentMessages,
    resetIds: async () => { await act(async () => setReadIds({})); },
    update: async (messages: CloudMessage[]) => { await act(async () => setMessages({ [peerId]: messages })); },
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

for (const activeId of [cloudCollaborationConversationId(peerId, 'person'), sessionId]) {
  test(`direct unread clears before acknowledgment without canonical history (${activeId.startsWith('session:') ? 'canonical' : 'contact'} route)`, async () => {
    const h = await mount(activeId);
    try {
      assert.equal(h.host.querySelectorAll('[data-unread-count]').length, 1);
      await h.render({ presented: true });
      assert.equal(h.host.querySelectorAll('[data-unread-count]').length, 0);
      assert.deepEqual(h.requests.map(request => request.sessionId), [sessionId]);
      assert.deepEqual([...h.ids()[peerId]], ['direct-1']);
    } finally { await h.close(); }
  });
}

test('direct read is presentation-gated and does not cover other sessions for the same peer', async () => {
  const h = await mount();
  try {
    await h.update([incoming, { ...incoming, messageId: 'agent-1', sessionId: 'session:agent:other' }, { ...incoming, messageId: 'group-1', sessionId: 'session:group:other' }]);
    assert.equal(h.requests.length, 0);
    await h.render({ presented: true });
    assert.deepEqual([...h.ids()[peerId]], ['direct-1']);
    assert.deepEqual(h.requests.map(request => request.sessionId), [sessionId]);
  } finally { await h.close(); }
});

test('an agent contact route cannot mark the person conversation read', async () => {
  const h = await mount(cloudCollaborationConversationId(peerId, 'agent'));
  try {
    await h.render({ presented: true });
    assert.equal(h.requests.length, 0);
    assert.equal(h.host.querySelectorAll('[data-unread-count]').length, 1);
  } finally { await h.close(); }
});

test('newer unread survives the acknowledgment for a previously visible direct message', async () => {
  const h = await mount();
  try {
    await h.render({ presented: true });
    await h.render({ presented: false });
    await h.update([incoming, { ...incoming, messageId: 'direct-2', conversationSequence: 2 }]);
    assert.equal(h.host.querySelectorAll('[data-unread-count]').length, 1);
    await act(async () => h.requests[0].resolve());
    assert.equal(h.host.querySelectorAll('[data-unread-count]').length, 1);
    assert.equal(h.ids()[peerId].has('direct-2'), false);
  } finally { await h.close(); }
});

test('a failed direct read rolls back only its covered messages and can retry', async () => {
  const h = await mount();
  try {
    await h.render({ presented: true });
    await act(async () => h.requests[0].reject());
    assert.equal(h.host.querySelectorAll('[data-unread-count]').length, 1);
    await h.render({ presented: false });
    await h.render({ presented: true });
    assert.equal(h.requests.length, 2);
    assert.equal(h.host.querySelectorAll('[data-unread-count]').length, 0);
  } finally { await h.close(); }
});

test('an older failed read cannot undo a newer acknowledgment in the same direct chat', async () => {
  const h = await mount();
  try {
    await h.render({ presented: true });
    await h.update([incoming, { ...incoming, messageId: 'direct-2', conversationSequence: 2 }]);
    await act(async () => h.requests[1].resolve());
    await act(async () => h.requests[0].reject());
    assert.equal(h.host.querySelectorAll('[data-unread-count]').length, 0);
    assert.equal(h.ids()[peerId].has('direct-2'), true);
  } finally { await h.close(); }
});

test('an older acknowledgment does not duplicate a read already covering newer messages', async () => {
  const h = await mount();
  try {
    await h.render({ presented: true });
    await h.update([incoming, { ...incoming, messageId: 'direct-2', conversationSequence: 2 }]);
    await act(async () => h.requests[0].resolve());
    assert.equal(h.requests.length, 2);
    await act(async () => h.requests[1].resolve());
    assert.equal(h.host.querySelectorAll('[data-unread-count]').length, 0);
  } finally { await h.close(); }
});

test('a failed older read rolls back IDs that a newer bounded snapshot does not cover', async () => {
  const h = await mount();
  try {
    await h.render({ presented: true });
    await h.update([{ ...incoming, messageId: 'direct-2', conversationSequence: 2 }]);
    await act(async () => h.requests[0].reject());
    assert.equal(h.ids()[peerId].has('direct-1'), false);
    assert.equal(h.ids()[peerId].has('direct-2'), true);
    await act(async () => h.requests[1].reject());
    assert.deepEqual(h.ids(), {});
  } finally { await h.close(); }
});

test('a stale transport snapshot cannot resurrect an acknowledged direct message', async () => {
  const h = await mount();
  try {
    await h.render({ presented: true });
    await act(async () => h.requests[0].resolve());
    await h.update([{ ...incoming }]);
    assert.equal(h.host.querySelectorAll('[data-unread-count]').length, 0);
    assert.equal(h.requests.length, 1);
  } finally { await h.close(); }
});

test('an explicitly scoped person route does not read the default direct session', async () => {
  const h = await mount(cloudCollaborationConversationId(peerId, 'person', 'session:other'));
  try {
    await h.render({ presented: true });
    assert.equal(h.requests.length, 0);
    assert.equal(h.host.querySelectorAll('[data-unread-count]').length, 1);
  } finally { await h.close(); }
});

for (const outcome of ['success', 'failure'] as const) {
  test(`a late direct read ${outcome} cannot mutate another account's tracking`, async () => {
    const h = await mount();
    try {
      await h.render({ presented: true });
      await h.render({ account: { accountId: 'acct_other' } as CloudAccount, presented: false });
      await h.resetIds();
      await act(async () => outcome === 'success' ? h.requests[0].resolve() : h.requests[0].reject());
      assert.deepEqual(h.ids(), {});
      assert.equal(h.messages()[peerId][0].readAt, null);
    } finally { await h.close(); }
  });
}
