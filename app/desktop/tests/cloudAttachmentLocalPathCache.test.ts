import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearCloudAttachmentLocalPathCache,
  cloudAttachmentPreviewCacheId,
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
