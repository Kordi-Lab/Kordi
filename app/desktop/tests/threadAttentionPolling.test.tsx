import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { THREAD_ATTENTION_REFRESH_MS, useThreadAttention } from '../src/features/cloud/threadAttention';
import { __setSessionBackendForTests } from '../src/features/cloud/session';

// Attention once polled every two seconds from every open window. Commits and
// reads refresh it directly, so the timer is only a slow repair path.
test('thread attention keeps one slow repair timer that skips hidden windows', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const timers: Array<{ callback: () => void; delay: number }> = [];
  let requests = 0;
  let visibility: 'visible' | 'hidden' = 'visible';
  Object.defineProperty(dom.window.document, 'visibilityState', { get: () => visibility, configurable: true });
  const realSetInterval = dom.window.setInterval.bind(dom.window);
  const replacement = {
    window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true,
    setInterval: ((callback: () => void, delay: number) => { timers.push({ callback, delay }); return realSetInterval(() => {}, 1e9); }) as typeof setInterval,
    fetch: async () => { requests += 1; return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }); },
  };
  const previous = new Map(Object.keys(replacement).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacement)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  __setSessionBackendForTests({
    load: async () => ({ accountId: 'test-account', token: 'test-token', expiresAt: '2099-01-01T00:00:00Z' }),
    save: async () => {}, clear: async () => {},
  });
  const root = createRoot(document.getElementById('root')!);
  function Harness() { useThreadAttention('test-account'); return null; }
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => root.render(<Harness />));
    assert.equal(timers.length, 1, 'a re-render must not add a second poll');
    assert.ok(timers[0].delay >= 15_000 && timers[0].delay === THREAD_ATTENTION_REFRESH_MS);
    const afterMount = requests;
    visibility = 'hidden';
    await act(async () => { timers[0].callback(); });
    assert.equal(requests, afterMount, 'a hidden window does not poll');
    visibility = 'visible';
    await act(async () => { dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange')); });
    assert.equal(requests, afterMount + 1, 'returning to the window refreshes at once');
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
