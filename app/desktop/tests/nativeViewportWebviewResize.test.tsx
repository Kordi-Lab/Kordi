import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import { useNativeViewport } from '../src/app/useNativeViewport';

test('closing a docked inspector restores the canvas without resizing the native window', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const values = { window: dom.window, document: dom.window.document, __TAURI_INTERNALS__: {}, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  mockWindows('main');
  let size: { width: number; height: number } | Promise<{ width: number; height: number }> = { width: 2960, height: 960 };
  mockIPC(command => command === 'plugin:window|scale_factor' ? 2
    : command === 'plugin:window|inner_size' ? size : undefined, { shouldMockEvents: true });
  const root = createRoot(document.getElementById('root')!);
  function Probe() { useNativeViewport(); return null; }
  const height = () => document.documentElement.style.getPropertyValue('--app-native-height');
  try {
    await act(async () => root.render(createElement(Probe)));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)); });
    assert.equal(height(), '480px');
    size = { width: 2960, height: 1960 };
    await act(async () => window.dispatchEvent(new dom.window.Event('resize')));
    assert.equal(height(), '980px', 'the inspector closes without a native window resize event');
    assert.equal(window.innerHeight, 768, 'the native query, not stale browser dimensions, supplies the size');

    let finishOldMeasurement: ((value: { width: number; height: number }) => void) | undefined;
    size = new Promise(resolve => { finishOldMeasurement = resolve; });
    await act(async () => window.dispatchEvent(new dom.window.Event('resize')));
    await act(async () => emit('tauri://resize', { width: 3000, height: 2100 }));
    await act(async () => finishOldMeasurement?.({ width: 2960, height: 1960 }));
    assert.equal(height(), '1050px', 'a delayed measurement must not undo a newer native resize');

    await act(async () => root.unmount());
    await act(async () => window.dispatchEvent(new dom.window.Event('resize')));
    assert.equal(height(), '');
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
