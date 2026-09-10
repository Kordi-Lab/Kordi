import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useThreadAttention } from '../src/features/cloud/threadAttention';
import { __setSessionBackendForTests } from '../src/features/cloud/session';
import { CHAT_SYNC_LOCAL_STATE_CHANGED_EVENT } from '../src/lib/desktopChatSync';

test('native commits refresh thread attention immediately and preserve refreshes arriving in flight', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const pending: Array<(count: number) => void> = [];
  const replacement = {
    window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async () => new Promise<Response>(resolve => pending.push(count => resolve(new Response(JSON.stringify([
      { conversation_id: 'conversation', session_id: 'session', unread_count: count,
        thread_unread_count: count, thread_count: count ? 1 : 0, next_root_id: null, next_message_id: null },
    ]), { status: 200, headers: { 'content-type': 'application/json' } })))),
  };
  const previous = new Map(Object.keys(replacement).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacement)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  __setSessionBackendForTests({
    load: async () => ({ accountId: 'test-account', token: 'test-token', expiresAt: '2099-01-01T00:00:00Z' }),
    save: async () => {}, clear: async () => {},
  });
  const host = document.getElementById('root')!;
  const root = createRoot(host);
  function Harness() {
    const attention = useThreadAttention('test-account');
    return <output>{attention?.session?.unread_count ?? 'loading'}</output>;
  }
  try {
    await act(async () => root.render(<Harness />));
    assert.equal(pending.length, 1);
    await act(async () => {
      window.dispatchEvent(new dom.window.Event(CHAT_SYNC_LOCAL_STATE_CHANGED_EVENT));
      window.dispatchEvent(new dom.window.Event(CHAT_SYNC_LOCAL_STATE_CHANGED_EVENT));
      pending[0](0);
    });
    assert.equal(pending.length, 2, 'events during a request must queue one immediate refresh');
    await act(async () => pending[1](1));
    assert.equal(host.textContent, '1');
    await act(async () => window.dispatchEvent(new dom.window.Event(CHAT_SYNC_LOCAL_STATE_CHANGED_EVENT)));
    assert.equal(pending.length, 3, 'a native commit must not wait for the polling timer');
    await act(async () => pending[2](0));
    assert.equal(host.textContent, '0');
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
