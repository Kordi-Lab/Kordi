import assert from 'node:assert/strict';
import test from 'node:test';

import { loadCloudAttachmentPreview } from '../src/features/cloud/cloudAttachments';

test('video posters use the shared preview loader without downloading video bytes', async () => {
  let previewDownloads = 0;
  let requestedAttachmentId = '';
  const result = await loadCloudAttachmentPreview({
    token: 'token',
    client: {
      async downloadAttachmentContent() {
        throw new Error('Video preview loading must not download the MP4.');
      },
      async downloadAttachmentPreviewContent(_token, attachmentId) {
        previewDownloads += 1;
        requestedAttachmentId = attachmentId;
        return new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });
      },
    },
    attachment: {
      attachmentId: 'att_video',
      previewAttachmentId: 'att_video_preview',
      name: 'video.mp4',
      kind: 'file',
      mimeType: 'video/mp4',
    },
    createObjectUrl: () => 'blob:video-poster',
  });

  assert.equal(result, 'blob:video-poster');
  assert.equal(previewDownloads, 1);
  assert.equal(requestedAttachmentId, 'att_video');
});
