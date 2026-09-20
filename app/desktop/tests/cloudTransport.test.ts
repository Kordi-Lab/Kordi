import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cloudFetchImpl } from '../src/features/cloud/cloudTransport';
import { CloudAuthClient } from '../src/features/cloud/authClient';
import { mockNativeHttpInvoke } from './helpers/nativeHttp';

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

test('native cloud transport returns JSON and preserves attachment MIME types', async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = (globalThis as { window?: unknown }).window;
  let platformFetchCalls = 0;
  globalThis.fetch = (async () => {
    platformFetchCalls += 1;
    throw new Error('The platform fetch must not run inside the desktop shell.');
  }) as typeof fetch;
  const requests: Request[] = [];
  (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {
    invoke: mockNativeHttpInvoke(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return request.url.endsWith('/content') || request.url.endsWith('/preview-content')
        ? new Response(new Uint8Array([4, 5]), { headers: { 'content-type': 'image/webp' } })
        : Response.json({ healthy: true });
    }),
  } };
  try {
    const response = await cloudFetchImpl()('http://localhost/v1/cloud/health');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { healthy: true });
    const client = new CloudAuthClient({ baseUrl: 'http://localhost' });
    for (const download of [client.downloadAttachmentContent.bind(client), client.downloadAttachmentPreviewContent.bind(client)]) {
      const blob = await download('synthetic-token', 'image');
      assert.equal(blob.type, 'image/webp');
      assert.deepEqual(Array.from(new Uint8Array(await blob.arrayBuffer())), [4, 5]);
    }
    assert.equal(requests.length, 3);
    assert.equal(requests[1].headers.get('authorization'), 'Bearer synthetic-token');
    assert.equal(requests[2].headers.get('authorization'), 'Bearer synthetic-token');
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
