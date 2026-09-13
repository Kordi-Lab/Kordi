import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement, StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { useCloudSyncPresentation, type CloudSyncPresentation } from '../src/features/cloud/useCloudSyncPresentation';

test('fresh model retry callbacks cannot create a parent-child update loop', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const values = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const root = createRoot(document.getElementById('root')!);
  let renders = 0;
  let retriedVersion = 0;
  function Model({ version, status, onChange }: {
    version: number;
    status: CloudSyncPresentation['status'];
    onChange: (sync: CloudSyncPresentation) => void;
  }) {
    renders++;
    if (renders > 12) throw new Error('Presentation entered an update loop');
    useCloudSyncPresentation({ status, onRetry: () => { retriedVersion = version; } }, onChange);
    return null;
  }
  function Parent({ version, status }: { version: number; status: CloudSyncPresentation['status'] }) {
    const [presentation, setPresentation] = useState<CloudSyncPresentation | null>(null);
    return createElement('div', null,
      createElement(Model, { version, status, onChange: setPresentation }),
      createElement('button', { onClick: presentation?.onRetry }, presentation?.status),
    );
  }
  try {
    await act(async () => root.render(createElement(StrictMode, null, createElement(Parent, { version: 1, status: 'syncing' }))));
    assert.equal(document.querySelector('button')?.textContent, 'syncing');
    renders = 0;
    await act(async () => root.render(createElement(StrictMode, null, createElement(Parent, { version: 2, status: 'syncing' }))));
    assert.ok(renders <= 2, 'retry-only changes must not update the parent');
    await act(async () => document.querySelector('button')!.click());
    assert.equal(retriedVersion, 2, 'stable retry delegates to the latest model');
    renders = 0;
    await act(async () => root.render(createElement(StrictMode, null, createElement(Parent, { version: 3, status: 'ready' }))));
    assert.equal(document.querySelector('button')?.textContent, 'ready');
    assert.ok(renders <= 4);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
