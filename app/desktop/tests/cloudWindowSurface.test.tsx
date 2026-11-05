import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC } from '@tauri-apps/api/mocks';

import { __setMainWindowShownForTests } from '../src/features/cloud/loginWindow';
import { MAIN_WINDOW_SHOW_FALLBACK_MS, useCloudWindowSurface } from '../src/features/cloud/useCloudWindowSurface';

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
  __setMainWindowShownForTests(true);
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
    // Let the shared native resize finish before the next test.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

type WindowHarness = {
  frames: Map<number, FrameRequestCallback>;
  calls: Array<{ command: string; args: Record<string, unknown> }>;
  pending: Array<() => void>;
  restore: () => void;
};

function nativeWindowHarness(): WindowHarness {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const values = {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    __TAURI_INTERNALS__: {},
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
  };
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const calls: WindowHarness['calls'] = [];
  const pending: Array<() => void> = [];
  mockIPC((command, args) => {
    calls.push({ command, args: (args ?? {}) as Record<string, unknown> });
    if (command !== 'desktop_set_auth_window_surface') return undefined;
    return new Promise<void>(resolve => pending.push(resolve));
  });
  return {
    frames,
    calls,
    pending,
    restore: () => {
      dom.window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

const settle = () => act(async () => { for (let i = 0; i < 10; i += 1) await new Promise(resolve => setImmediate(resolve)); });
const shows = (harness: WindowHarness) => harness.calls.filter(call => call.command === 'desktop_reveal_main_window').length;
// Native calls cross an asynchronous import, so give them real time to land.
const waitForResize = async (harness: WindowHarness) => {
  for (let i = 0; i < 50 && harness.pending.length === 0; i += 1) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
};
const waitForShows = async (harness: WindowHarness, count: number) => {
  for (let i = 0; i < 50 && shows(harness) < count; i += 1) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  return shows(harness);
};

test('the hidden window takes the welcome size at once and shows only after that screen paints', { timeout: 10_000 }, async () => {
  const harness = nativeWindowHarness();
  __setMainWindowShownForTests(false);
  const root = createRoot(document.getElementById('root')!);
  let ready = false;
  function Probe({ surface }: { surface: 'welcome' | 'main' | null }) {
    ready = useCloudWindowSurface(surface);
    return null;
  }
  try {
    await act(async () => root.render(createElement(StrictMode, null, createElement(Probe, { surface: 'welcome' }))));
    await waitForResize(harness);
    const resizes = harness.calls.filter(call => call.command === 'desktop_set_auth_window_surface');
    assert.equal(resizes.length, 1, 'nothing is on screen, so no frame is awaited before sizing');
    assert.deepEqual(resizes[0].args, { surface: 'welcome', animate: false });
    assert.equal(shows(harness), 0, 'the bare window must stay hidden while it is sized');
    await act(async () => harness.pending.shift()!());
    await settle();
    assert.equal(ready, true, 'the welcome screen renders at its final size while hidden');
    assert.equal(shows(harness), 0, 'the window waits for that screen to paint');
    await act(async () => { const callbacks = [...harness.frames.values()]; harness.frames.clear(); callbacks.forEach(callback => callback(0)); });
    await act(async () => { const callbacks = [...harness.frames.values()]; harness.frames.clear(); callbacks.forEach(callback => callback(0)); });
    assert.equal(await waitForShows(harness, 1), 1, 'the window shows once the welcome screen has painted');

    await act(async () => root.render(createElement(StrictMode, null, createElement(Probe, { surface: 'main' }))));
    await settle();
    assert.equal(harness.calls.filter(call => call.command === 'desktop_set_auth_window_surface').length, 1,
      'a shown window paints the current screen before it resizes');
  } finally {
    await act(async () => root.unmount());
    harness.restore();
  }
});

test('the hidden window still shows when WebKit holds its frames', { timeout: 10_000 }, async () => {
  const harness = nativeWindowHarness();
  __setMainWindowShownForTests(false);
  const root = createRoot(document.getElementById('root')!);
  function Probe() {
    useCloudWindowSurface('login');
    return null;
  }
  try {
    await act(async () => root.render(createElement(Probe)));
    await waitForResize(harness);
    await act(async () => harness.pending.shift()!());
    // No animation frame is ever delivered here.
    assert.equal(await waitForShows(harness, 1), 1);
  } finally {
    await act(async () => root.unmount());
    harness.restore();
  }
});

test('a slow first screen still shows the hidden window', { timeout: 10_000 }, async () => {
  const harness = nativeWindowHarness();
  __setMainWindowShownForTests(false);
  mock.timers.enable({ apis: ['setTimeout'] });
  const root = createRoot(document.getElementById('root')!);
  function Probe() {
    useCloudWindowSurface(null);
    return null;
  }
  try {
    await act(async () => root.render(createElement(Probe)));
    mock.timers.tick(MAIN_WINDOW_SHOW_FALLBACK_MS - 1);
    await settle();
    assert.equal(shows(harness), 0);
    mock.timers.tick(1);
    mock.timers.reset();
    assert.equal(await waitForShows(harness, 1), 1, 'loading the session must not keep the window hidden');
  } finally {
    mock.timers.reset();
    await act(async () => root.unmount());
    harness.restore();
  }
});
