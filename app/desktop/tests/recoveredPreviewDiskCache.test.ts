import assert from 'node:assert/strict';
import test from 'node:test';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import { recoverCloudAttachmentPreview } from '../src/features/cloud/cloudAttachmentPreviewRecovery';
import { cachedCloudAttachmentLocalPath, clearCloudAttachmentLocalPathCache } from '../src/features/cloud/cloudAttachmentLocalPathCache';

test('native recovered thumbnails are durable under the same key and filename used by the card', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: {} });
  const writes: Array<Record<string, unknown>> = [];
  let published = false;
  try {
    clearCloudAttachmentLocalPathCache();
    mockIPC((command, args) => {
      assert.equal(command, 'desktop_chat_cache_cloud_attachment');
      writes.push(args as Record<string, unknown>);
      return '/synthetic-cache/preview.png';
    });
    const result = await recoverCloudAttachmentPreview({
      token: 'synthetic', attachment: { attachmentId: 'recovered-local', name: 'Original.png', kind: 'image' },
      client: { downloadAttachmentContent: async () => new Blob(['original']), updateAttachmentPreview: async () => { published = true; assert.equal(writes.length, 1); } },
      createPreviewDataUrl: async () => 'data:image/png;base64,cHJldmlldw==',
    });
    assert.equal(result, 'data:image/png;base64,cHJldmlldw==');
    assert.equal(published, true);
    assert.equal(writes[0].attachmentId, 'preview:recovered-local');
    assert.equal(writes[0].name, 'Original.png');
    assert.equal(cachedCloudAttachmentLocalPath('preview:recovered-local'), '/synthetic-cache/preview.png');
  } finally {
    clearMocks(); clearCloudAttachmentLocalPathCache();
    if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window');
  }
});
