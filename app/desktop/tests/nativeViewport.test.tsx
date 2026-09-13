import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import { useNativeViewport } from '../src/app/useNativeViewport';

test('native client size updates layout before stale WebKit viewport metrics catch up', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  Object.defineProperty(dom.window, 'devicePixelRatio', { value: 2 });
  const values = { window: dom.window, document: dom.window.document, __TAURI_INTERNALS__: {}, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  mockWindows('main');
  mockIPC(() => {}, { shouldMockEvents: true });
  const root = createRoot(document.getElementById('root')!);
  let renders = 0;
  function Probe() { renders++; useNativeViewport(); return null; }
  try {
    await act(async () => root.render(createElement(Probe)));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)); });
    const initialRenders = renders;
    for (const height of [1520, 1800, 2080]) {
      await act(async () => emit('tauri://resize', { width: 2384, height }));
      assert.equal(document.documentElement.style.getPropertyValue('--app-native-height'), `${height / 2}px`);
      assert.equal(document.documentElement.style.getPropertyValue('--app-native-width'), '1192px');
      assert.equal(window.innerHeight, 768, 'test keeps WebKit viewport stale');
    }
    assert.equal(renders, initialRenders, 'native dimensions must not rerender the entire app model');
    await act(async () => root.unmount());
    assert.equal(document.documentElement.style.getPropertyValue('--app-native-height'), '');
    await new Promise(resolve => setTimeout(resolve, 0));
    await emit('tauri://resize', { width: 2000, height: 2000 });
    assert.equal(document.documentElement.style.getPropertyValue('--app-native-height'), '');
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
