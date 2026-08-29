import assert from 'node:assert/strict';
import test from 'node:test';

import { CloudAuthClient } from '../src/features/cloud/authClient';
import { cloudAttachmentPlaybackUrl } from '../src/features/cloud/cloudAttachmentPlayback';

test('attachment preview fetches authenticated canonical thumbnail bytes', async () => {
  let request: { url: string; init?: RequestInit } | null = null;
  const client = new CloudAuthClient({
    baseUrl: 'http://srv',
    fetchImpl: async (input, init) => {
      request = { url: String(input), init };
      return new Response(new Uint8Array([4, 5]), {
        status: 200,
        headers: { 'content-type': 'image/webp' },
      });
    },
  });

  const blob = await client.downloadAttachmentPreviewContent('kordi_cs_xyz', 'att_1');

  assert.equal(blob.type, 'image/webp');
  assert.deepEqual(Array.from(new Uint8Array(await blob.arrayBuffer())), [4, 5]);
  assert.equal(request?.url, 'http://srv/v1/cloud/attachments/att_1/preview-content');
  assert.deepEqual(request?.init?.headers, { authorization: 'Bearer kordi_cs_xyz' });
});

test('attachment playback mints a range-capable URL without exposing the session token', async () => {
  let request: { url: string; init?: RequestInit } | null = null;
  const client = new CloudAuthClient({
    baseUrl: 'http://srv',
    fetchImpl: async (input, init) => {
      request = { url: String(input), init };
      return Response.json({
        playbackPath: '/v1/cloud/public/attachments/att_1/content?token=p1.signed',
        expiresAt: '2026-08-28T12:00:00Z',
      });
    },
  });

  const url = await cloudAttachmentPlaybackUrl(client, 'kordi_cs_private', 'att_1', 'http://srv');

  assert.equal(url, 'http://srv/v1/cloud/public/attachments/att_1/content?token=p1.signed');
  assert.equal(request?.url, 'http://srv/v1/cloud/attachments/att_1/playback');
  assert.deepEqual(request?.init?.headers, { authorization: 'Bearer kordi_cs_private' });
  assert.doesNotMatch(url, /kordi_cs_private/);
});
