import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC } from '@tauri-apps/api/mocks';

import { useCloudWindowSurface } from '../src/features/cloud/useCloudWindowSurface';

test('native surface readiness waits for resize paint, resets on return, and recovers from failure', { timeout: 10_000 }, async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  let reduceMotion = false;
  const values = {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    __TAURI_INTERNALS__: {},
    matchMedia: () => ({ matches: reduceMotion }),
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
  };
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const requests: Array<{ surface: string; animate: boolean; resolve: () => void; reject: () => void }> = [];
  const requestWaiters = new Map<number, () => void>();
  const waitForRequests = async (count: number) => {
    await act(async () => {
      if (requests.length < count) {
        await new Promise<void>(resolve => requestWaiters.set(count, resolve));
      }
    });
    assert.equal(requests.length, count);
  };
  mockIPC((command, args) => {
    assert.equal(command, 'desktop_set_auth_window_surface');
    return new Promise<void>((resolve, reject) => {
      requests.push({ ...args as { surface: string; animate: boolean }, resolve, reject: () => reject(new Error('Resize failed')) });
      requestWaiters.get(requests.length)?.();
      requestWaiters.delete(requests.length);
    });
  });
  const root = createRoot(document.getElementById('root')!);
  let ready = false;
  function Probe({ surface }: { surface: 'login' | 'signup' | 'main' }) {
    ready = useCloudWindowSurface(surface);
    return null;
  }
  const render = async (surface: 'login' | 'signup' | 'main') => {
    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(Probe, { surface })));
    });
  };
  const paint = async () => {
    await act(async () => {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach(callback => callback(0));
    });
  };
  try {
    await render('login');
    assert.equal(requests.length, 0, 'loading content must paint before native resize');
    await paint();
    assert.equal(requests.length, 0);
    await paint();
    // Every native call crosses an asynchronous import, even after module caching.
    await waitForRequests(1);
    assert.equal(requests.length, 1, 'StrictMode must share the native resize');
    assert.equal(ready, false);
    assert.equal(requests[0].animate, true);
    await act(async () => requests[0].resolve());
    await paint();
    assert.equal(ready, false, 'wait for the final webview resize paint');
    await paint();
    assert.equal(ready, true);

    await render('main');
    await paint();
    await paint();
    await waitForRequests(2);
    assert.equal(ready, false);
    reduceMotion = true;
    await render('login');
    await paint();
    await paint();
    assert.equal(ready, false, 'a prior login size must not reveal a new login visit');
    await act(async () => requests[1].resolve());
    await waitForRequests(3);
    assert.equal(requests[2].surface, 'login');
    assert.equal(requests[2].animate, false);
    await act(async () => requests[2].reject());
    await paint();
    await paint();
    assert.equal(ready, true, 'window-manager failures must not block login');

    await render('signup');
    await paint();
    await paint();
    await waitForRequests(4);
    await act(async () => root.unmount());
    await act(async () => requests[3].resolve());
    assert.equal(frames.size, 0, 'unmounted surfaces must not schedule reveal work');
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
