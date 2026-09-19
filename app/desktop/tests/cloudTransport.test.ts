import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cloudFetchImpl } from '../src/features/cloud/cloudTransport';

test('cloud transport uses the platform fetch outside the desktop shell', async () => {
  const originalFetch = globalThis.fetch;
  let platformFetchCalls = 0;
  globalThis.fetch = (async () => {
    platformFetchCalls += 1;
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    const response = await cloudFetchImpl()('https://kordi.ai/v1/cloud/health');
    assert.equal(response.status, 200);
    assert.equal(platformFetchCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('cloud transport routes through the native plugin inside the desktop shell', async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = (globalThis as { window?: unknown }).window;
  let platformFetchCalls = 0;
  globalThis.fetch = (async () => {
    platformFetchCalls += 1;
    throw new Error('The platform fetch must not run inside the desktop shell.');
  }) as typeof fetch;
  (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
  try {
    await assert.rejects(cloudFetchImpl()('https://kordi.ai/v1/cloud/health'));
    assert.equal(platformFetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  }
});
