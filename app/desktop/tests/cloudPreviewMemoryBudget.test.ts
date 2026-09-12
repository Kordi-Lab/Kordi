import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  CLOUD_ATTACHMENT_PREVIEW_CACHE_BYTES,
  acquireCloudAttachmentPreviewLease,
  cachedCloudAttachmentPreviewResource,
  clearCloudAttachmentPreviewCache,
  cloudAttachmentPreviewCacheUsage,
  retainCloudAttachmentPreviewResource,
} from '../src/features/cloud/cloudAttachmentPreviewCache';
import { loadVisibleCloudAttachmentPreview, resetCloudAttachmentPreviewLoader } from '../src/features/cloud/cloudAttachments';
import { cloudPreviewMemoryCost } from '../src/features/cloud/cloudAttachmentPreviewDownload';

afterEach(() => { resetCloudAttachmentPreviewLoader(); clearCloudAttachmentPreviewCache(); });

test('byte cost evicts idle previews before the entry-count limit', (context) => {
  const revoked: string[] = [];
  context.mock.method(URL, 'revokeObjectURL', (url: string) => { revoked.push(url); });
  for (let index = 0; index < 3; index += 1) {
    const resource = retainCloudAttachmentPreviewResource(String(index), `blob:${index}`, CLOUD_ATTACHMENT_PREVIEW_CACHE_BYTES / 2);
    acquireCloudAttachmentPreviewLease(resource).release();
  }
  assert.deepEqual(revoked, ['blob:0']);
  assert.deepEqual(cloudAttachmentPreviewCacheUsage(), { entries: 2, estimatedBytes: CLOUD_ATTACHMENT_PREVIEW_CACHE_BYTES });
  assert.equal(cachedCloudAttachmentPreviewResource('0'), null);
});

test('oversized visible previews remain valid until their final lease is released', (context) => {
  const revoked: string[] = [];
  context.mock.method(URL, 'revokeObjectURL', (url: string) => { revoked.push(url); });
  const resource = retainCloudAttachmentPreviewResource('large', 'blob:large', CLOUD_ATTACHMENT_PREVIEW_CACHE_BYTES + 1);
  const first = acquireCloudAttachmentPreviewLease(resource);
  const second = first.retain();
  assert.deepEqual(cloudAttachmentPreviewCacheUsage(), { entries: 0, estimatedBytes: 0 });
  assert.equal(resource.revoked, false);
  first.release();
  clearCloudAttachmentPreviewCache();
  assert.deepEqual(revoked, []);
  second.release();
  second.release();
  assert.deepEqual(revoked, ['blob:large']);
});

test('the download path accounts for blob bytes and source pixel dimensions', async (context) => {
  const revoked: string[] = [];
  context.mock.method(URL, 'createObjectURL', () => 'blob:large-frame');
  context.mock.method(URL, 'revokeObjectURL', (url: string) => { revoked.push(url); });
  const attachment = { attachmentId: 'frame', name: 'frame.png', kind: 'image' as const, widthPixels: 4_096, heightPixels: 4_096 };
  assert.equal(cloudPreviewMemoryCost(attachment, 100), 4_096 * 4_096 * 4 + 100);
  const lease = await loadVisibleCloudAttachmentPreview({
    token: 'fixture', attachment,
    client: { downloadAttachmentContent: async () => new Blob(['small encoded image']) },
  });
  assert.equal(lease?.previewUrl, 'blob:large-frame');
  assert.equal(cloudAttachmentPreviewCacheUsage().entries, 0);
  assert.deepEqual(revoked, []);
  lease?.release();
  assert.deepEqual(revoked, ['blob:large-frame']);
});

test('simultaneous oversized downloads remain leased through queue publication', async (context) => {
  const revoked: string[] = [];
  let urls = 0;
  context.mock.method(URL, 'createObjectURL', () => `blob:large-${++urls}`);
  context.mock.method(URL, 'revokeObjectURL', (url: string) => { revoked.push(url); });
  const leases = await Promise.all(['first', 'second'].map((id) => loadVisibleCloudAttachmentPreview({
    token: 'fixture',
    attachment: { attachmentId: id, name: `${id}.png`, kind: 'image', widthPixels: 4_096, heightPixels: 4_096 },
    client: { downloadAttachmentContent: async () => new Blob([id]) },
  })));
  assert.equal(leases.filter(Boolean).length, 2);
  assert.equal(cloudAttachmentPreviewCacheUsage().entries, 0);
  assert.deepEqual(revoked, []);
  leases.forEach((lease) => lease?.release());
  assert.deepEqual(revoked.sort(), ['blob:large-1', 'blob:large-2']);
});
