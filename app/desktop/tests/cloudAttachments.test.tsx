import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cloudMessageAttachmentToMessageAttachment,
  uploadComposerAttachments,
} from '../src/features/cloud/cloudAttachments';
import type { CloudAuthClient } from '../src/features/cloud/authClient';

test('cloud attachment metadata maps to transcript attachment metadata', () => {
  assert.deepEqual(cloudMessageAttachmentToMessageAttachment({
    attachmentId: 'att_1',
    name: 'Screenshot.png',
    kind: 'image',
    mimeType: 'image/png',
    sizeBytes: 2048,
    downloadUrl: 'https://files.test/att_1',
    previewUrl: null,
  }), {
    kind: 'image',
    name: 'Screenshot.png',
    mimeType: 'image/png',
    sizeBytes: 2048,
    previewUrl: 'https://files.test/att_1',
    localPath: null,
  });
});

test('uploadComposerAttachments reads staged local files and preserves display metadata', async () => {
  const readPaths: string[] = [];
  const uploads: Array<{ blob: Blob; name: string; kind: string }> = [];
  const client = {
    async uploadAttachment(_token: string, blob: Blob) {
      uploads.push({ blob, name: '', kind: '' });
      return {
        attachmentId: 'att_1',
        objectKey: 'attachments/acct/att_1',
        sizeBytes: blob.size,
        contentType: blob.type,
        sha256Hex: null,
        finalizedAt: '2026-05-12T00:00:00Z',
      };
    },
  } as Pick<CloudAuthClient, 'uploadAttachment'>;

  const result = await uploadComposerAttachments({
    token: 'kordi_cs_xyz',
    client,
    attachments: [{
      id: 'local-1',
      path: '/tmp/report.pdf',
      name: 'report.pdf',
      kind: 'file',
      mimeType: 'application/pdf',
      sizeBytes: 3,
    }],
    readAttachment: async (path) => {
      readPaths.push(path);
      return [1, 2, 3];
    },
  });

  assert.deepEqual(readPaths, ['/tmp/report.pdf']);
  assert.equal(uploads[0]?.blob.type, 'application/pdf');
  assert.deepEqual(result, [{
    attachmentId: 'att_1',
    name: 'report.pdf',
    kind: 'file',
    mimeType: 'application/pdf',
    sizeBytes: 3,
  }]);
});
