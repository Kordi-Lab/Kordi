import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  CloudAttachmentPreviewQueue,
  clearCloudAttachmentLocalPathCacheForTests,
  cloudMessageAttachmentToMessageAttachment,
  loadCloudAttachmentPreview,
  resolveCloudMessageAttachments,
  uploadCloudFiles,
  uploadComposerAttachments,
} from '../src/features/cloud/cloudAttachments';
import type { CloudAuthClient } from '../src/features/cloud/authClient';

afterEach(() => {
  clearCloudAttachmentLocalPathCacheForTests();
});

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

test('visible preview loading uses the thumbnail attachment id when provided', async () => {
  const requestedIds: string[] = [];
  const result = await loadCloudAttachmentPreview({
    token: 'token',
    client: {
      async downloadAttachmentContent(_token, attachmentId) {
        requestedIds.push(attachmentId);
        return new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' });
      },
    },
    attachment: {
      attachmentId: 'att_original',
      previewAttachmentId: 'att_preview',
      name: 'photo.png',
      kind: 'image',
      mimeType: 'image/png',
      sizeBytes: 8_000_000,
    },
    createObjectUrl: () => 'blob:preview',
  });

  assert.deepEqual(requestedIds, ['att_preview']);
  assert.equal(result, 'blob:preview');
});

test('preview queue caps recovery at four downloads and aborts queued rows', async () => {
  const queue = new CloudAttachmentPreviewQueue(4);
  const releases: Array<() => void> = [];
  const started: number[] = [];
  const controllers = Array.from({ length: 6 }, () => new AbortController());
  const requests = controllers.map((controller, index) => queue.run(async () => {
    started.push(index);
    await new Promise<void>((resolve) => releases.push(resolve));
    return index;
  }, controller.signal));
  const resultsPromise = Promise.allSettled(requests);

  await Promise.resolve();
  assert.deepEqual(started, [0, 1, 2, 3]);
  controllers[5].abort();
  releases.shift()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [0, 1, 2, 3, 4]);
  releases.splice(0).forEach((release) => release());
  const results = await resultsPromise;
  assert.equal(results[5]?.status, 'rejected');
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

test('uploadCloudFiles stores browser file attachments locally so direct chat sender previews immediately', async () => {
  const stored: Array<{ name: string; data: number[] }> = [];
  const client = {
    async uploadAttachment(_token: string, blob: Blob) {
      return {
        attachmentId: 'att_direct_uploaded',
        objectKey: 'attachments/acct/att_direct_uploaded',
        sizeBytes: blob.size,
        contentType: blob.type,
        sha256Hex: null,
        finalizedAt: '2026-05-12T00:00:00Z',
      };
    },
    async downloadAttachmentContent() {
      throw new Error('should reuse stored direct-chat file path');
    },
  } as Pick<CloudAuthClient, 'uploadAttachment' | 'downloadAttachmentContent'>;

  const uploaded = await uploadCloudFiles({
    token: 'kordi_cs_xyz',
    client,
    files: [new File([new Uint8Array([7, 8, 9])], 'direct.png', { type: 'image/png' })],
    storeAttachment: async (name, data) => {
      stored.push({ name, data });
      return '/tmp/kordi-cache/direct.png';
    },
  });

  assert.deepEqual(stored, [{ name: 'direct.png', data: [7, 8, 9] }]);
  assert.equal(uploaded[0]?.localPath, '/tmp/kordi-cache/direct.png');

  const resolved = await resolveCloudMessageAttachments({
    token: 'kordi_cs_xyz',
    client,
    attachments: [{
      attachmentId: 'att_direct_uploaded',
      name: 'direct.png',
      kind: 'image',
      mimeType: 'image/png',
      sizeBytes: 3,
    }],
  });

  assert.equal(resolved[0]?.localPath, '/tmp/kordi-cache/direct.png');
});

test('uploadComposerAttachments seeds local cache so own sent image preview survives cloud refresh', async () => {
  const client = {
    async uploadAttachment(_token: string, blob: Blob) {
      return {
        attachmentId: 'att_uploaded_preview_cache',
        objectKey: 'attachments/acct/att_uploaded_preview_cache',
        sizeBytes: blob.size,
        contentType: blob.type,
        sha256Hex: null,
        finalizedAt: '2026-05-12T00:00:00Z',
      };
    },
    async downloadAttachmentContent() {
      throw new Error('should reuse the staged local path instead of downloading immediately');
    },
  } as Pick<CloudAuthClient, 'uploadAttachment' | 'downloadAttachmentContent'>;

  await uploadComposerAttachments({
    token: 'kordi_cs_xyz',
    client,
    attachments: [{
      id: 'local-preview',
      path: '/tmp/local-screenshot.png',
      name: 'local-screenshot.png',
      kind: 'image',
      mimeType: 'image/png',
      sizeBytes: 3,
    }],
    readAttachment: async () => [1, 2, 3],
  });

  const result = await resolveCloudMessageAttachments({
    token: 'kordi_cs_xyz',
    client,
    attachments: [{
      attachmentId: 'att_uploaded_preview_cache',
      name: 'local-screenshot.png',
      kind: 'image',
      mimeType: 'image/png',
      sizeBytes: 3,
    }],
  });

  assert.equal(result[0]?.localPath, '/tmp/local-screenshot.png');
});

test('cloudMessageAttachmentToMessageAttachment uses upload cache for immediate own-sent preview', async () => {
  const client = {
    async uploadAttachment(_token: string, blob: Blob) {
      return {
        attachmentId: 'att_immediate_preview',
        objectKey: 'attachments/acct/att_immediate_preview',
        sizeBytes: blob.size,
        contentType: blob.type,
        sha256Hex: null,
        finalizedAt: '2026-05-20T00:00:00Z',
      };
    },
  } as Pick<CloudAuthClient, 'uploadAttachment'>;

  await uploadComposerAttachments({
    token: 'kordi_cs_xyz',
    client,
    attachments: [{
      id: 'local-1',
      path: '/tmp/kordi/Screenshot 2026-05-20.png',
      name: 'Screenshot 2026-05-20.png',
      kind: 'image',
      mimeType: 'image/png',
      sizeBytes: 138 * 1024,
    }],
    readAttachment: async () => [1, 2, 3],
  });

  const mapped = cloudMessageAttachmentToMessageAttachment({
    attachmentId: 'att_immediate_preview',
    name: 'Screenshot 2026-05-20.png',
    kind: 'image',
    mimeType: 'image/png',
    sizeBytes: 138 * 1024,
  });

  assert.equal(mapped.localPath, '/tmp/kordi/Screenshot 2026-05-20.png');
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
