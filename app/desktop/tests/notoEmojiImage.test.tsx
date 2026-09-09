import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { NotoEmojiImage } from '../src/features/emoji/NotoEmojiImage';
import { notoEmojiAssetUrl, notoEmojiCatalog } from '../src/features/emoji/notoEmoji';
import { clearRemoteAvatarImageCacheForTests } from '../src/kordi-app/components/remoteAvatarImage';

const imageData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6Q2sAAAAASUVORK5CYII=';

function setup() {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true, url: 'https://desktop.kordi.test',
  });
  const pending = new Map<string, { resolve: (data: string) => void; reject: (error: Error) => void }>();
  const requestListeners = new Map<string, Set<() => void>>();
  const calls: string[] = [];
  Object.defineProperty(dom.window, '__TAURI_INTERNALS__', {
    value: { invoke: (_command: string, args: { url: string }) => {
      calls.push(args.url);
      return new Promise<string>((resolve, reject) => {
        pending.set(args.url, { resolve, reject });
        requestListeners.get(args.url)?.forEach(listener => listener());
        requestListeners.delete(args.url);
      });
    } }, configurable: true,
  });
  const replacements: Record<string, unknown> = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const style = dom.window.document.createElement('style');
  style.textContent = readFileSync(new URL('../src/styles/shell-expressive-picker.css', import.meta.url), 'utf8');
  dom.window.document.head.append(style);
  const root = createRoot(dom.window.document.getElementById('root')!);
  clearRemoteAvatarImageCacheForTests();
  async function waitForRequest(url: string) {
    if (pending.has(url)) return;
    await new Promise<void>((resolve, reject) => {
      const listeners = requestListeners.get(url) ?? new Set<() => void>();
      const listener = () => {
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => {
        listeners.delete(listener);
        reject(new Error('Native request did not start: ' + url));
      }, 10_000);
      listeners.add(listener);
      requestListeners.set(url, listeners);
    });
  }
  return {
    dom, pending, calls, root, waitForRequest,
    async settle(url: string, fail = false) {
      await waitForRequest(url);
      const request = pending.get(url);
      assert.ok(request, `Expected a pending request for ${url}`);
      await act(async () => { if (fail) request.reject(new Error('Offline')); else request.resolve(imageData); });
    },
    async close() {
      await act(async () => root.unmount());
      clearRemoteAvatarImageCacheForTests();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      dom.window.close();
    },
  };
}

const emoji = notoEmojiCatalog.find(item => item.id === '1f602')!;

test('Noto keeps its decoded still visible until the animated replacement loads', async () => {
  const app = setup();
  try {
    await act(async () => app.root.render(<NotoEmojiImage emoji={emoji} animated={false} />));
    assert.equal(app.dom.window.document.querySelector('.app-noto-fallback')?.textContent, '😂');
    await app.settle(notoEmojiAssetUrl(emoji, 'png'));
    const still = app.dom.window.document.querySelector<HTMLImageElement>('.app-noto-still')!;
    await act(async () => still.dispatchEvent(new app.dom.window.Event('load')));
    assert.equal(app.dom.window.getComputedStyle(still).opacity, '1');

    await act(async () => app.root.render(<NotoEmojiImage emoji={emoji} animated />));
    assert.equal(app.dom.window.document.querySelector('.app-noto-still'), still);
    assert.equal(app.dom.window.getComputedStyle(still).opacity, '1');
    await app.settle(notoEmojiAssetUrl(emoji, 'webp'));
    const animation = app.dom.window.document.querySelector<HTMLImageElement>('.app-noto-animation')!;
    assert.equal(animation.dataset.ready, 'false');
    assert.equal(app.dom.window.getComputedStyle(still).opacity, '1');
    await act(async () => animation.dispatchEvent(new app.dom.window.Event('load')));
    assert.equal(app.dom.window.getComputedStyle(still).opacity, '0');

    await act(async () => app.root.render(<NotoEmojiImage emoji={emoji} animated={false} />));
    assert.equal(app.dom.window.document.querySelector('.app-noto-still'), still);
    assert.equal(app.dom.window.getComputedStyle(still).opacity, '1');
    assert.equal(app.dom.window.document.querySelector('.app-noto-animation'), null);
  } finally { await app.close(); }
});

test('repeated Noto copies share requests and retain Unicode after asset failures', async () => {
  const app = setup();
  try {
    await act(async () => app.root.render(<><NotoEmojiImage emoji={emoji} /><NotoEmojiImage emoji={emoji} /></>));
    await app.waitForRequest(notoEmojiAssetUrl(emoji, 'webp'));
    await app.waitForRequest(notoEmojiAssetUrl(emoji, 'png'));
    assert.equal(app.calls.filter(url => url === notoEmojiAssetUrl(emoji, 'webp')).length, 1);
    assert.equal(app.calls.filter(url => url === notoEmojiAssetUrl(emoji, 'png')).length, 1);
    await app.settle(notoEmojiAssetUrl(emoji, 'png'), true);
    await app.settle(notoEmojiAssetUrl(emoji, 'webp'), true);
    await app.waitForRequest(notoEmojiAssetUrl(emoji, 'gif'));
    assert.equal(app.calls.filter(url => url === notoEmojiAssetUrl(emoji, 'gif')).length, 1);
    await app.settle(notoEmojiAssetUrl(emoji, 'gif'), true);
    for (const fallback of app.dom.window.document.querySelectorAll('.app-noto-fallback')) {
      assert.equal(fallback.textContent, '😂');
      assert.notEqual(app.dom.window.getComputedStyle(fallback).visibility, 'hidden');
    }
  } finally { await app.close(); }
});
