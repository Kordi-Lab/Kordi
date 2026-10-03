import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { INTERFACE_ZOOM_STORAGE_KEY, interfaceZoomForShortcut, readStoredInterfaceZoom, useInterfaceZoom } from '../src/app/interfaceZoom';

test('interface zoom restores valid sizes and bounds keyboard resizing', () => {
  for (const value of [null, '', 'invalid', '-1', 'Infinity']) {
    assert.equal(readStoredInterfaceZoom({ getItem: () => value }), 1);
  }
  assert.equal(readStoredInterfaceZoom({ getItem: () => '0.2' }), 0.7);
  assert.equal(readStoredInterfaceZoom({ getItem: () => '4' }), 1.6);
  assert.equal(readStoredInterfaceZoom({ getItem: () => { throw Error('Storage unavailable'); } }), 1);
  assert.equal(interfaceZoomForShortcut(1, '+'), 1.1);
  assert.equal(interfaceZoomForShortcut(1, '='), 1.1);
  assert.equal(interfaceZoomForShortcut(0.7, '-'), 0.7);
  assert.equal(interfaceZoomForShortcut(1.6, '+'), 1.6);
  assert.equal(interfaceZoomForShortcut(1.4, '0'), 1);
  assert.equal(interfaceZoomForShortcut(1, 'a'), null);
});

test('native zoom handles Command shortcuts and retains the composer draft', async () => {
  const dom = new JSDOM('<div id="root"></div><textarea>Keep this draft</textarea>', { url: 'http://localhost' });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true });
  const sizes: number[] = [];
  mockWindows('main');
  mockIPC((command, args) => {
    assert.equal(command, 'plugin:webview|set_webview_zoom');
    sizes.push(args.value as number);
  });
  function Harness() { useInterfaceZoom(true); return null; }
  const root = createRoot(document.getElementById('root')!);
  const editor = document.querySelector('textarea')!;
  try {
    window.localStorage.setItem(INTERFACE_ZOOM_STORAGE_KEY, '0.9');
    await act(async () => root.render(createElement(Harness)));
    editor.focus();
    const press = async (key: string, metaKey = true, altKey = false) => {
      const event = new dom.window.KeyboardEvent('keydown', { key, metaKey, altKey, bubbles: true, cancelable: true });
      await act(async () => { editor.dispatchEvent(event); });
      return event.defaultPrevented;
    };
    assert.equal(await press('='), true);
    assert.equal(await press('+'), true);
    assert.equal(await press('-'), true);
    assert.equal(await press('0'), true);
    assert.equal(await press('-', false), false);
    assert.equal(await press('+', true, true), false);
    assert.deepEqual(sizes, [0.9, 1, 1.1, 1, 1]);
    assert.equal(editor.value, 'Keep this draft');
    assert.equal(document.activeElement, editor);
    assert.equal(window.localStorage.getItem(INTERFACE_ZOOM_STORAGE_KEY), '1');
    assert.equal(document.documentElement.dataset.kordiInterfaceZoom, '1');
  } finally {
    await act(async () => root.unmount());
    clearMocks();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});

test('late native zoom responses cannot replace the latest size or update an unmounted view', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true });
  const pending: Array<{ value: number; resolve: () => void }> = [];
  mockWindows('main');
  mockIPC((command, args) => {
    assert.equal(command, 'plugin:webview|set_webview_zoom');
    return new Promise<void>(resolve => pending.push({ value: args.value as number, resolve }));
  });
  function Harness() { useInterfaceZoom(true); return null; }
  const root = createRoot(document.getElementById('root')!);
  try {
    await act(async () => root.render(createElement(Harness)));
    const press = async () => {
      await act(async () => { document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: '+', metaKey: true, bubbles: true, cancelable: true })); });
    };
    await press();
    await press();
    assert.deepEqual(pending.map(request => request.value), [1, 1.1, 1.2]);
    await act(async () => pending[2].resolve());
    assert.equal(document.documentElement.dataset.kordiInterfaceZoom, '1.2');
    await act(async () => { pending[1].resolve(); pending[0].resolve(); });
    assert.equal(document.documentElement.dataset.kordiInterfaceZoom, '1.2');
    assert.equal(document.documentElement.style.getPropertyValue('--app-interface-zoom'), '1.2');
    await press();
    await act(async () => root.unmount());
    await act(async () => pending[3].resolve());
    assert.equal(document.documentElement.dataset.kordiInterfaceZoom, '1.2');
  } finally {
    await act(async () => root.unmount());
    clearMocks();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});
