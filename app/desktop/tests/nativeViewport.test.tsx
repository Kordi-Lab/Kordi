import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import { useNativeViewport } from '../src/app/useNativeViewport';
import { useInterfaceZoom } from '../src/app/interfaceZoom';

test('native client size updates layout before stale WebKit viewport metrics catch up', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  Object.defineProperty(dom.window, 'devicePixelRatio', { value: 2 });
  const values = { window: dom.window, document: dom.window.document, __TAURI_INTERNALS__: {}, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  mockWindows('main');
  mockIPC(command => command === 'plugin:window|scale_factor' ? 2
    : command === 'plugin:window|inner_size' ? { width: 2384, height: 1520 } : undefined, { shouldMockEvents: true });
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

test('zoom and native resize keep the canvas filling the window at both zoom limits', async () => {
  const dom = new JSDOM('<div id="root"></div><textarea>Keep this draft</textarea>', { url: 'http://localhost' });
  Object.defineProperty(dom.window, 'devicePixelRatio', { value: 2, writable: true });
  const values = { window: dom.window, document: dom.window.document, __TAURI_INTERNALS__: {}, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  mockWindows('main');
  let displayScale = 2;
  mockIPC((command, args) => {
    if (command === 'plugin:window|scale_factor') return displayScale;
    if (command === 'plugin:window|inner_size') return { width: 2960, height: 1960 };
    if (command === 'plugin:webview|set_webview_zoom') dom.window.devicePixelRatio = displayScale * (args.value as number);
  }, { shouldMockEvents: true });
  const root = createRoot(document.getElementById('root')!);
  function Probe() { useNativeViewport(); useInterfaceZoom(true); return null; }
  const editor = document.querySelector('textarea')!;
  const canvasFills = (width: number, height: number, zoom: number) => {
    const style = document.documentElement.style;
    assert.ok(Math.abs(parseFloat(style.getPropertyValue('--app-native-width')) * zoom - width) < 0.01);
    assert.ok(Math.abs(parseFloat(style.getPropertyValue('--app-native-height')) * zoom - height) < 0.01);
  };
  try {
    await act(async () => root.render(createElement(Probe)));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)); });
    editor.focus();
    const press = async (key: string) => {
      await act(async () => { editor.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, metaKey: true, bubbles: true, cancelable: true })); });
    };
    for (let i = 0; i < 3; i++) await press('-');
    canvasFills(1480, 980, 0.7);
    await act(async () => emit('tauri://resize', { width: 4000, height: 2400 }));
    canvasFills(2000, 1200, 0.7);
    for (let i = 0; i < 9; i++) await press('+');
    canvasFills(2000, 1200, 1.6);
    // Moving to a display with a different pixel density must not double-scale.
    displayScale = 1;
    dom.window.devicePixelRatio = displayScale * 1.6;
    await act(async () => emit('tauri://scale-change', { scaleFactor: 1, size: { width: 2000, height: 1200 } }));
    canvasFills(2000, 1200, 1.6);
    await act(async () => emit('tauri://resize', { width: 2200, height: 1300 }));
    canvasFills(2200, 1300, 1.6);
    await press('0');
    canvasFills(2200, 1300, 1);
    assert.equal(editor.value, 'Keep this draft');
    assert.equal(document.activeElement, editor);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('a delayed initial measurement preserves newer native resize and display-scale events', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const values = { window: dom.window, document: dom.window.document, __TAURI_INTERNALS__: {}, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  mockWindows('main');
  let resolveSize: ((size: { width: number; height: number }) => void) | undefined;
  const initialSize = new Promise<{ width: number; height: number }>(resolve => { resolveSize = resolve; });
  mockIPC(command => command === 'plugin:window|scale_factor' ? 2
    : command === 'plugin:window|inner_size' ? initialSize : undefined, { shouldMockEvents: true });
  const root = createRoot(document.getElementById('root')!);
  function Probe() { useNativeViewport(); return null; }
  try {
    await act(async () => root.render(createElement(Probe)));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)); });
    await act(async () => emit('tauri://resize', { width: 4000, height: 2400 }));
    await act(async () => emit('tauri://scale-change', { scaleFactor: 1, size: { width: 2200, height: 1300 } }));
    await act(async () => emit('tauri://resize', { width: 2400, height: 1400 }));
    await act(async () => resolveSize?.({ width: 2960, height: 1960 }));
    assert.equal(document.documentElement.style.getPropertyValue('--app-native-width'), '2400px');
    assert.equal(document.documentElement.style.getPropertyValue('--app-native-height'), '1400px');
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
