import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

import { useCloudAuthTransition, waitForCloudAuthCover } from '../src/features/cloud/useCloudAuthTransition';
import { CloudOAuthCancelledError } from '../src/features/cloud/cloudOAuthCancellation';

test('auth mutations wait for the loading cover; failure restores the form state', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const values = {
    window: dom.window, document: dom.window.document,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const root = createRoot(document.getElementById('root')!);
  let transition!: ReturnType<typeof useCloudAuthTransition>;
  let signIns = 0;
  let signOuts = 0;
  const actions = {
    signIn: () => { signIns++; return Promise.reject(new Error('Invalid credentials')); },
    signUp: () => Promise.resolve(),
    signInWithProvider: () => Promise.resolve(),
    signOut: () => { signOuts++; return Promise.resolve(); },
  };
  function Probe() {
    transition = useCloudAuthTransition(actions);
    return createElement('div', null, transition.activity ?? 'form');
  }
  try {
    await act(async () => root.render(createElement(Probe)));
    let attempt!: Promise<unknown>;
    await act(async () => {
      attempt = transition.signIn('test@example.test', 'test-only').catch(error => error);
    });
    assert.equal(document.getElementById('root')!.textContent, 'signing-in');
    assert.equal(signIns, 0, 'the account must not change ahead of the cover');
    await act(async () => { assert.match(String(await attempt), /Invalid credentials/); });
    assert.equal(signIns, 1);
    assert.equal(document.getElementById('root')!.textContent, 'form');

    let exit!: Promise<void>;
    await act(async () => {
      exit = transition.signOut();
      assert.equal(transition.signOut(), exit, 'duplicate clicks share one pending mutation');
    });
    assert.equal(document.getElementById('root')!.textContent, 'signing-out');
    assert.equal(signOuts, 0, 'the workspace must remain mounted until covered');
    await act(async () => exit);
    assert.equal(signOuts, 1);
    assert.equal(transition.activity, null);

    let cancelled!: Promise<void>;
    await act(async () => { cancelled = transition.signOut(); });
    await act(async () => root.unmount());
    await cancelled;
    assert.equal(signOuts, 1, 'unmounting during the cover must cancel the delayed mutation');
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('a throttled or hidden WebKit window cannot indefinitely delay starting authentication', { timeout: 2000 }, async () => {
  const values = {
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
  };
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  try {
    await waitForCloudAuthCover();
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('canceling social sign-in restores the login state and permits an immediate retry', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const values = {
    window: dom.window, document: dom.window.document,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const root = createRoot(document.getElementById('root')!);
  let transition!: ReturnType<typeof useCloudAuthTransition>;
  let attempts = 0;
  const actions = {
    signIn: async () => {},
    signUp: async () => {},
    signInWithProvider: async (_provider: 'google' | 'github', signal?: AbortSignal) => {
      attempts += 1;
      if (attempts === 1) {
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new CloudOAuthCancelledError()), { once: true });
        });
      }
    },
    signOut: async () => {},
  };
  function Probe() {
    transition = useCloudAuthTransition(actions);
    return createElement('div', null, transition.activity ?? 'form');
  }
  try {
    await act(async () => root.render(createElement(Probe)));
    let first!: Promise<unknown>;
    await act(async () => {
      first = transition.socialSignIn('google').catch(error => error);
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
    assert.equal(attempts, 1);
    assert.equal(document.getElementById('root')!.textContent, 'social-signing-in');

    await act(async () => {
      transition.cancelSocialSignIn();
      assert.ok(await first instanceof CloudOAuthCancelledError);
    });
    assert.equal(document.getElementById('root')!.textContent, 'form');

    await act(async () => { await transition.socialSignIn('google'); });
    assert.equal(attempts, 2);
    assert.equal(document.getElementById('root')!.textContent, 'form');
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
