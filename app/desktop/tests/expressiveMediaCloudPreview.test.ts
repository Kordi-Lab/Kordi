import assert from 'node:assert/strict';
import test from 'node:test';

import { loadCloudAttachmentPreview } from '../src/features/cloud/cloudAttachments';

test('GIF preview loading uses the original animated attachment', async () => {
  const requestedOriginalIds: string[] = [];
  let previewRequests = 0;
  const result = await loadCloudAttachmentPreview({
    token: 'token',
    client: {
      async downloadAttachmentPreviewContent() {
        previewRequests += 1;
        return new Blob([new Uint8Array([1])], { type: 'image/png' });
      },
      async downloadAttachmentContent(_token, attachmentId) {
        requestedOriginalIds.push(attachmentId);
        return new Blob([new Uint8Array([1, 2, 3])], { type: 'image/gif' });
      },
    },
    attachment: {
      attachmentId: 'att_gif_original',
      previewAttachmentId: 'att_gif_static_preview',
      name: 'dance.gif',
      kind: 'image',
      mimeType: 'image/gif',
    },
    createObjectUrl: () => 'blob:animated-gif',
  });

  assert.equal(previewRequests, 0);
  assert.deepEqual(requestedOriginalIds, ['att_gif_original']);
  assert.equal(result, 'blob:animated-gif');
});
