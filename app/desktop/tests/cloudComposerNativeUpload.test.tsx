import assert from 'node:assert/strict';
import test from 'node:test';

import { uploadComposerAttachments } from '../src/features/cloud/cloudComposerAttachments';
import type { CloudAuthClient } from '../src/features/cloud/authClient';

test('composer uploads keep native file bytes out of JavaScript', async () => {
  let nativePath = '';
  const client = {
    async uploadAttachment() {
      throw new Error('native composer uploads must not use Blob transport');
    },
  } as unknown as Pick<CloudAuthClient, 'uploadAttachment'>;

  const result = await uploadComposerAttachments({
    token: 'kordi_cs_xyz',
    client,
    attachments: [{
      id: 'native-large-file',
      path: '/staged/Kordi.app.zip',
      name: 'Kordi.app.zip',
      kind: 'file',
      mimeType: 'application/zip',
      sizeBytes: 250 * 1024 * 1024,
    }],
    useNativeUpload: true,
    readAttachment: async () => {
      throw new Error('native composer uploads must not read bytes over Tauri IPC');
    },
    nativeUpload: async ({ path }) => {
      nativePath = path;
      return {
        attachmentId: 'att_native',
        objectKey: 'attachments/acct/att_native',
        sizeBytes: 250 * 1024 * 1024,
        contentType: 'application/zip',
        sha256Hex: 'a'.repeat(64),
        finalizedAt: '2026-08-18T00:00:00Z',
      };
    },
  });

  assert.equal(nativePath, '/staged/Kordi.app.zip');
  assert.equal(result[0]?.attachmentId, 'att_native');
  assert.equal(result[0]?.sizeBytes, 250 * 1024 * 1024);
});
