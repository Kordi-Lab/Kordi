import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { CloudAuthClient } from '../src/features/cloud/authClient';
import { __setSessionBackendForTests } from '../src/features/cloud/session';
import { useThreadReadStatus } from '../src/features/cloud/useThreadReadStatus';
import { threadUnreadMarkerMessageId } from '../src/features/chat/threadReadState';
import type { MessageThread } from '../src/features/chat/messageThreads';
import type { CloudThreadRead } from '../src/features/cloud/chatSyncTypes';

const rootId = '10000000-0000-4000-8000-000000000001';
const replyId = '20000000-0000-4000-8000-000000000002';
const thread: MessageThread = {
  root: { id: 'local-root', reactionTargetMessageId: rootId, role: 'person', text: 'Root', time: '12:00' },
  replies: [{ id: 'local-reply', clientMessageId: 'client-reply', reactionTargetMessageId: replyId, role: 'person', text: 'Unread reply', time: '12:01', conversationSequence: 12 }],
};

test('the marker stays until the confirmed read cursor reaches its reply', () => {
  assert.equal(threadUnreadMarkerMessageId(thread, replyId, null), replyId);
  assert.equal(threadUnreadMarkerMessageId(thread, replyId, {}), replyId);
  assert.equal(threadUnreadMarkerMessageId(thread, replyId, { [rootId]: 11 }), replyId);
  assert.equal(threadUnreadMarkerMessageId(thread, replyId, { unrelated: 100 }), replyId);
  assert.equal(threadUnreadMarkerMessageId(thread, replyId, { [rootId]: 12 }), null);
  assert.equal(threadUnreadMarkerMessageId(thread, replyId, { [rootId]: 20 }), null);
});

test('read markers recognize local, canonical, and client reply identities', () => {
  for (const id of ['local-reply', replyId, 'client-reply']) {
    assert.equal(threadUnreadMarkerMessageId(thread, id, { [rootId]: 12 }), null);
  }
  assert.equal(threadUnreadMarkerMessageId(thread, null, { [rootId]: 12 }), null);
  assert.equal(threadUnreadMarkerMessageId({ ...thread, replies: [] }, replyId, { [rootId]: 12 }), replyId);
  assert.equal(threadUnreadMarkerMessageId({ ...thread, replies: [{ ...thread.replies[0], conversationSequence: undefined }] }, replyId, { [rootId]: 12 }), replyId);
});

test('a successful read acknowledgement removes the rendered marker without reloading the thread', async (t) => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const replacements = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  __setSessionBackendForTests({ load: async () => ({ accountId: 'viewer', token: 'synthetic', expiresAt: '2099-01-01' }), save: async () => {}, clear: async () => {} });
  const initialReads = t.mock.method(CloudAuthClient.prototype, 'threadReads', async () => []);
  let rejectRead = true;
  let acknowledge: ((read: CloudThreadRead) => void) | undefined;
  t.mock.method(CloudAuthClient.prototype, 'markThreadRead', async () => {
    if (rejectRead) throw new Error('Synthetic connection failure');
    return new Promise<CloudThreadRead>(resolve => { acknowledge = resolve; });
  });
  function Harness() {
    const status = useThreadReadStatus('session', 'viewer', true);
    const marker = threadUnreadMarkerMessageId(thread, replyId, status.reads);
    return <>
      <button onClick={() => void status.markRead(rootId, 12).catch(() => {})}>Read visible replies</button>
      {marker ? <div data-unread-marker>New replies</div> : null}
    </>;
  }
  const host = document.getElementById('root')!;
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Harness />));
    assert.ok(host.querySelector('[data-unread-marker]'));
    await act(async () => host.querySelector('button')!.click());
    assert.ok(host.querySelector('[data-unread-marker]'), 'A failed read must preserve the marker');
    rejectRead = false;
    await act(async () => host.querySelector('button')!.click());
    assert.ok(acknowledge);
    assert.ok(host.querySelector('[data-unread-marker]'), 'Do not clear before confirmation');
    await act(async () => acknowledge!({ root_message_id: rootId, root_client_message_id: 'root-client', last_read_sequence: 12 }));
    assert.equal(Boolean(host.querySelector('[data-unread-marker]')), false);
    assert.equal(initialReads.mock.callCount(), 1, 'No reload or next poll is needed');
  } finally {
    await act(async () => root.unmount());
    __setSessionBackendForTests(null);
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});
