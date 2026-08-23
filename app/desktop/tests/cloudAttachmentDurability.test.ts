import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadCloudAttachmentPreview,
} from '../src/features/cloud/cloudAttachments';
import { uploadComposerAttachments } from '../src/features/cloud/cloudComposerAttachments';

test('preview loading prefers canonical bytes and falls back to the original', async () => {
  for (const previewAvailable of [true, false]) {
    const requested: string[] = [];
    const result = await loadCloudAttachmentPreview({
      token: 'token',
      client: {
        async downloadAttachmentPreviewContent() {
          requested.push('preview');
          if (!previewAvailable) throw new Error('Preview not found');
          return new Blob([new Uint8Array([1])], { type: 'image/webp' });
        },
        async downloadAttachmentContent() {
          requested.push('original');
          return new Blob([new Uint8Array([2])], { type: 'image/png' });
        },
      },
      attachment: { attachmentId: 'att_1', name: 'image.png', kind: 'image' },
      createObjectUrl: (blob) => `blob:${blob.type}`,
    });
    assert.equal(result, previewAvailable ? 'blob:image/webp' : 'blob:image/png');
    assert.deepEqual(requested, previewAvailable ? ['preview'] : ['preview', 'original']);
  }
});

test('image upload stores its generated preview on the canonical attachment', async () => {
  const updates: string[] = [];
  await uploadComposerAttachments({
    token: 'token',
    client: {
      async uploadAttachment(_token, blob) {
        return { attachmentId: 'att_2', objectKey: 'key', sizeBytes: blob.size, contentType: blob.type, sha256Hex: null, finalizedAt: 'now' };
      },
      async updateAttachmentPreview(_token, attachmentId, previewUrl) {
        updates.push(`${attachmentId}:${previewUrl}`);
        return { attachmentId, previewUrl, updatedLinks: 1 };
      },
    },
    attachments: [{ id: 'local', path: '/tmp/image.png', name: 'image.png', kind: 'image', mimeType: 'image/png', sizeBytes: 3 }],
    readAttachment: async () => [1, 2, 3],
    createPreviewDataUrl: async () => 'data:image/webp;base64,preview',
    useNativeUpload: false,
  });

  assert.deepEqual(updates, ['att_2:data:image/webp;base64,preview']);
});
