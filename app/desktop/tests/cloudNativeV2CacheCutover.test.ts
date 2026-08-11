import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cloudMessagesUseBrowserCache } from '../src/features/cloud/useCloudAccountLifecycleState';

test('native v2 bypasses the legacy browser cache while web retains IndexedDB', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  try {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { __TAURI_INTERNALS__: {} },
    });
    assert.equal(cloudMessagesUseBrowserCache(), false);

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });
    assert.equal(cloudMessagesUseBrowserCache(), true);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
    else delete (globalThis as { window?: unknown }).window;
  }
});
