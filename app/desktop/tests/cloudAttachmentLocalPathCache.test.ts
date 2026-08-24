import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cacheCloudAttachmentLocalPath,
  cachedCloudAttachmentLocalPath,
  clearCloudAttachmentLocalPathCache,
  cloudAttachmentPreviewCacheId,
  downloadCloudAttachmentToLocalPath,
  loadCachedCloudAttachmentLocalPath,
  persistCloudAttachmentBytes,
} from '../src/features/cloud/cloudAttachmentLocalPathCache';

test('preview cache keys cannot replace original attachment files', () => {
  assert.equal(cloudAttachmentPreviewCacheId('att_1'), 'preview:att_1');
  assert.equal(cloudAttachmentPreviewCacheId('att_1', 'att_thumb'), 'preview:att_thumb');
});

test('cloud attachment paths restore from durable storage once and stay memory-hot', async () => {
  clearCloudAttachmentLocalPathCache();
  let reads = 0;
  const load = async () => {
    reads += 1;
    return '/cache/att_1-image.png';
  };

  assert.equal(
    await loadCachedCloudAttachmentLocalPath('att_1', 'image.png', load),
    '/cache/att_1-image.png',
  );
  assert.equal(
    await loadCachedCloudAttachmentLocalPath('att_1', 'image.png', load),
    '/cache/att_1-image.png',
  );
  assert.equal(reads, 1);
});

test('downloaded preview bytes populate the durable and memory caches', async () => {
  clearCloudAttachmentLocalPathCache();
  let storedBytes: number[] = [];
  const path = await persistCloudAttachmentBytes(
    'att_2',
    'preview.webp',
    new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' }),
    async (_attachmentId, _name, bytes) => {
      storedBytes = bytes;
      return '/cache/att_2-preview.webp';
    },
  );

  assert.equal(path, '/cache/att_2-preview.webp');
  assert.deepEqual(storedBytes, [1, 2, 3]);
  assert.equal(
    await loadCachedCloudAttachmentLocalPath('att_2', 'preview.webp', async () => null),
    path,
  );
});

test('memory path cache evicts the least recently used entry', () => {
  clearCloudAttachmentLocalPathCache();
  for (let index = 0; index < 256; index += 1) {
    cacheCloudAttachmentLocalPath(`att_${index}`, `/cache/${index}`);
  }
  assert.equal(cachedCloudAttachmentLocalPath('att_0'), '/cache/0');
  cacheCloudAttachmentLocalPath('att_256', '/cache/256');

  assert.equal(cachedCloudAttachmentLocalPath('att_1'), null);
  assert.equal(cachedCloudAttachmentLocalPath('att_0'), '/cache/0');
});

test('native downloads become memory-hot without transferring bytes through JavaScript', async () => {
  clearCloudAttachmentLocalPathCache();
  let downloads = 0;
  const download = async () => {
    downloads += 1;
    return '/cache/streamed.bin';
  };

  assert.equal(
    await downloadCloudAttachmentToLocalPath('token', 'att_stream', 'streamed.bin', download),
    '/cache/streamed.bin',
  );
  assert.equal(
    await downloadCloudAttachmentToLocalPath('token', 'att_stream', 'streamed.bin', download),
    '/cache/streamed.bin',
  );
  assert.equal(downloads, 1);
});

test('native download failures remain actionable to the attachment control', async () => {
  clearCloudAttachmentLocalPathCache();

  await assert.rejects(
    downloadCloudAttachmentToLocalPath(
      'token',
      'att_failed',
      'failed.bin',
      async () => { throw new Error('Download failed.'); },
    ),
    /Download failed/,
  );
});
