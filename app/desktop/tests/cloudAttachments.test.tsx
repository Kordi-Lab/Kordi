import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cloudMessageAttachmentToMessageAttachment,
  resolveCloudMessageAttachments,
  uploadComposerAttachments,
} from '../src/features/cloud/cloudAttachments';
import type { CloudAuthClient } from '../src/features/cloud/authClient';

test('cloud attachment metadata maps to transcript attachment metadata without exposing object-store URLs', () => {
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
    previewUrl: null,
    downloadUrl: null,
    localPath: null,
    attachmentId: 'att_1',
  });
});

test('resolveCloudMessageAttachments auto-downloads small files into local attachment cache', async () => {
  const stored: Array<{ name: string; data: number[] }> = [];
  const client = {
    async downloadAttachmentContent(_token: string, attachmentId: string) {
      assert.equal(attachmentId, 'att_1');
      return new Blob([new Uint8Array([4, 5, 6])], { type: 'image/png' });
    },
  } as Pick<CloudAuthClient, 'downloadAttachmentContent'>;

  const result = await resolveCloudMessageAttachments({
    token: 'kordi_cs_xyz',
    client,
    attachments: [{
      attachmentId: 'att_1',
      name: 'screen.png',
      kind: 'image',
      mimeType: 'image/png',
      sizeBytes: 3,
    }],
    storeAttachment: async (name, data) => {
      stored.push({ name, data });
      return '/tmp/kordi-cache/screen.png';
    },
  });

  assert.deepEqual(stored, [{ name: 'screen.png', data: [4, 5, 6] }]);
  assert.equal(result[0]?.localPath, '/tmp/kordi-cache/screen.png');
});

test('resolveCloudMessageAttachments leaves large files for manual download', async () => {
  let downloaded = false;
  const client = {
    async downloadAttachmentContent() {
      downloaded = true;
      return new Blob([]);
    },
  } as Pick<CloudAuthClient, 'downloadAttachmentContent'>;

  const result = await resolveCloudMessageAttachments({
    token: 'kordi_cs_xyz',
    client,
    autoDownloadMaxBytes: 10,
    attachments: [{
      attachmentId: 'att_large',
      name: 'large.zip',
      kind: 'file',
      mimeType: 'application/zip',
      sizeBytes: 11,
    }],
  });

  assert.equal(downloaded, false);
  assert.equal(result[0]?.localPath, null);
  assert.equal(result[0]?.attachmentId, 'att_large');
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
