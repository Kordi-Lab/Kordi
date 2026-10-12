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

async function withNativeShell<T>(handler: typeof fetch, run: (openResources: () => number) => Promise<T>): Promise<T> {
  const originalWindow = (globalThis as { window?: unknown }).window;
  const invoke = mockNativeHttpInvoke(handler);
  (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: { invoke } };
  try {
    return await run(() => invoke.openResources());
  } finally {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  }
}

const settleReleases = () => new Promise(resolve => setTimeout(resolve, 0));

test('native cloud transport releases every native resource it opens', async () => {
  await withNativeShell(async (input) => {
    const url = new Request(input).url;
    if (url.endsWith('/heartbeat')) return new Response(null, { status: 204 });
    if (url.endsWith('/missing')) return Response.json({ code: 'not_found' }, { status: 404 });
    return Response.json({ healthy: true }, { headers: { 'x-request-id': 'req_example' } });
  }, async (openResources) => {
    const fetchImpl = cloudFetchImpl();
    for (let index = 0; index < 5; index += 1) {
      const read = await fetchImpl('http://localhost/v1/cloud/health');
      assert.deepEqual(await read.json(), { healthy: true });
      assert.equal(read.headers.get('x-request-id'), 'req_example');
      assert.equal(read.url, 'http://localhost/v1/cloud/health');
      const empty = await fetchImpl('http://localhost/v1/cloud/heartbeat', { method: 'POST' });
      assert.equal(empty.status, 204);
      assert.equal(empty.body, null);
      // A caller that only checks the status never reads this body.
      const unread = await fetchImpl('http://localhost/v1/cloud/missing');
      assert.equal(unread.status, 404);
    }
    await settleReleases();
    assert.equal(openResources(), 0);
  });
});

test('native cloud transport rejects an aborted request without leaking it', async () => {
  await withNativeShell(async () => Response.json({}), async (openResources) => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(cloudFetchImpl()('http://localhost/v1/cloud/health', { signal: controller.signal }), /Request cancelled/);
    await settleReleases();
    assert.equal(openResources(), 0);
  });
});
