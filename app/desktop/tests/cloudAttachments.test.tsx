import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  CLOUD_ATTACHMENT_PREVIEW_CACHE_CAPACITY,
  CloudAttachmentPreviewQueue,
  clearCloudAttachmentLocalPathCacheForTests,
  cloudMessageAttachmentToMessageAttachment,
  loadCloudAttachmentPreview,
  loadVisibleCloudAttachmentPreview,
  resetCloudAttachmentPreviewLoader,
  resolveCloudMessageAttachments,
  uploadCloudFiles,
  uploadComposerAttachments,
} from '../src/features/cloud/cloudAttachments';
import type { CloudAuthClient } from '../src/features/cloud/authClient';

function imagePreviewAttachment(attachmentId: string) {
  return {
    attachmentId,
    kind: 'image' as const,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

async function flushMicrotasks(count: number) {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

function assertAbortResult(result: PromiseSettledResult<string | null> | undefined) {
  assert.equal(result?.status, 'rejected');
  if (result?.status === 'rejected') {
    assert.equal(result.reason instanceof Error ? result.reason.name : null, 'AbortError');
  }
}

function installObjectUrlSpies() {
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  const created: string[] = [];
  const revoked: string[] = [];
  URL.createObjectURL = () => {
    const url = `blob:cloud-preview-${created.length + 1}`;
    created.push(url);
    return url;
  };
  URL.revokeObjectURL = (url) => revoked.push(url);
  return {
    created,
    revoked,
    restore() {
      URL.createObjectURL = originalCreateObjectUrl;
      URL.revokeObjectURL = originalRevokeObjectUrl;
    },
  };
}

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

test('visible preview cache stays bounded, revokes the oldest Blob URL, and reloads it after eviction', async () => {
  const objectUrls = installObjectUrlSpies();
  const downloadCounts = new Map<string, number>();
  const client = {
    async downloadAttachmentContent(_token: string, attachmentId: string) {
      downloadCounts.set(attachmentId, (downloadCounts.get(attachmentId) ?? 0) + 1);
      return new Blob([attachmentId]);
    },
  } as Pick<CloudAuthClient, 'downloadAttachmentContent'>;

  try {
    for (let index = 0; index <= CLOUD_ATTACHMENT_PREVIEW_CACHE_CAPACITY; index += 1) {
      await loadVisibleCloudAttachmentPreview({
        token: 'token',
        client,
        attachment: imagePreviewAttachment(`preview-${index}`),
      });
    }

    assert.deepEqual(objectUrls.revoked, ['blob:cloud-preview-1']);

    const reloaded = await loadVisibleCloudAttachmentPreview({
      token: 'token',
      client,
      attachment: imagePreviewAttachment('preview-0'),
    });

    assert.equal(reloaded, `blob:cloud-preview-${CLOUD_ATTACHMENT_PREVIEW_CACHE_CAPACITY + 2}`);
    assert.equal(downloadCounts.get('preview-0'), 2);
    assert.deepEqual(objectUrls.revoked, ['blob:cloud-preview-1', 'blob:cloud-preview-2']);
  } finally {
    resetCloudAttachmentPreviewLoader();
    objectUrls.restore();
  }
});

test('visible preview cache hits refresh LRU recency and reset revokes each retained Blob URL once', async () => {
  const objectUrls = installObjectUrlSpies();
  const client = {
    async downloadAttachmentContent(_token: string, attachmentId: string) {
      return new Blob([attachmentId]);
    },
  } as Pick<CloudAuthClient, 'downloadAttachmentContent'>;

  try {
    for (let index = 0; index < CLOUD_ATTACHMENT_PREVIEW_CACHE_CAPACITY; index += 1) {
      await loadVisibleCloudAttachmentPreview({
        token: 'token',
        client,
        attachment: imagePreviewAttachment(`preview-${index}`),
      });
    }
    const recentlyUsed = await loadVisibleCloudAttachmentPreview({
      token: 'token',
      client,
      attachment: imagePreviewAttachment('preview-0'),
    });
    await loadVisibleCloudAttachmentPreview({
      token: 'token',
      client,
      attachment: imagePreviewAttachment(`preview-${CLOUD_ATTACHMENT_PREVIEW_CACHE_CAPACITY}`),
    });

    assert.equal(recentlyUsed, 'blob:cloud-preview-1');
    assert.deepEqual(objectUrls.revoked, ['blob:cloud-preview-2']);

    resetCloudAttachmentPreviewLoader();
    resetCloudAttachmentPreviewLoader();

    assert.equal(objectUrls.revoked.length, CLOUD_ATTACHMENT_PREVIEW_CACHE_CAPACITY + 1);
    assert.equal(new Set(objectUrls.revoked).size, CLOUD_ATTACHMENT_PREVIEW_CACHE_CAPACITY + 1);
    assert.equal(objectUrls.revoked.filter((url) => url === 'blob:cloud-preview-2').length, 1);
  } finally {
    resetCloudAttachmentPreviewLoader();
    objectUrls.restore();
  }
});

test('concurrent duplicate preview results revoke the superseded Blob URL instead of leaking it', async () => {
  const objectUrls = installObjectUrlSpies();
  const releases: Array<(blob: Blob) => void> = [];
  const client = {
    async downloadAttachmentContent() {
      return new Promise<Blob>((resolve) => releases.push(resolve));
    },
  } as Pick<CloudAuthClient, 'downloadAttachmentContent'>;

  try {
    const first = loadVisibleCloudAttachmentPreview({
      token: 'token',
      client,
      attachment: imagePreviewAttachment('shared-preview'),
    });
    const second = loadVisibleCloudAttachmentPreview({
      token: 'token',
      client,
      attachment: imagePreviewAttachment('shared-preview'),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(releases.length, 2);

    releases[0]?.(new Blob(['first']));
    const firstUrl = await first;
    releases[1]?.(new Blob(['second']));
    const secondUrl = await second;

    assert.equal(firstUrl, 'blob:cloud-preview-1');
    assert.equal(secondUrl, firstUrl);
    assert.deepEqual(objectUrls.revoked, ['blob:cloud-preview-2']);

    resetCloudAttachmentPreviewLoader();
    assert.deepEqual(objectUrls.revoked, ['blob:cloud-preview-2', 'blob:cloud-preview-1']);
  } finally {
    resetCloudAttachmentPreviewLoader();
    objectUrls.restore();
  }
});

test('reset rejects a freshly retained preview when it runs before queue settlement', async () => {
  const objectUrls = installObjectUrlSpies();
  const firstDownload = deferred<Blob>();
  let downloadCount = 0;
  const client = {
    downloadAttachmentContent() {
      downloadCount += 1;
      return downloadCount === 1 ? firstDownload.promise : Promise.resolve(new Blob(['reloaded']));
    },
  } as Pick<CloudAuthClient, 'downloadAttachmentContent'>;

  try {
    const request = loadVisibleCloudAttachmentPreview({
      token: 'token',
      client,
      attachment: imagePreviewAttachment('reset-fresh-preview'),
    });
    const resultPromise = Promise.allSettled([request]);
    firstDownload.resolve(new Blob(['fresh']));
    await flushMicrotasks(1);
    assert.deepEqual(objectUrls.created, ['blob:cloud-preview-1']);

    resetCloudAttachmentPreviewLoader();

    const result = await resultPromise;
    assertAbortResult(result[0]);
    assert.deepEqual(objectUrls.revoked, ['blob:cloud-preview-1']);

    const reloaded = await loadVisibleCloudAttachmentPreview({
      token: 'token',
      client,
      attachment: imagePreviewAttachment('reset-fresh-preview'),
    });
    assert.equal(downloadCount, 2);
    assert.equal(reloaded, 'blob:cloud-preview-2');
    resetCloudAttachmentPreviewLoader();
    assert.deepEqual(objectUrls.revoked, ['blob:cloud-preview-1', 'blob:cloud-preview-2']);
  } finally {
    resetCloudAttachmentPreviewLoader();
    objectUrls.restore();
  }
});

test('reset rejects a cached-inside-queue preview before its public promise settles', async () => {
  const objectUrls = installObjectUrlSpies();
  const sharedDownload = deferred<Blob>();
  const blockerDownloads = Array.from({ length: 3 }, () => deferred<Blob>());
  let sharedDownloadCount = 0;
  const client = {
    downloadAttachmentContent(_token: string, attachmentId: string) {
      if (attachmentId === 'reset-cached-preview') {
        sharedDownloadCount += 1;
        return sharedDownloadCount === 1
          ? sharedDownload.promise
          : Promise.resolve(new Blob(['reloaded']));
      }
      const blockerIndex = Number(attachmentId.replace('reset-blocker-', ''));
      return blockerDownloads[blockerIndex]?.promise ?? Promise.reject(new Error('unexpected preview id'));
    },
  } as Pick<CloudAuthClient, 'downloadAttachmentContent'>;

  try {
    const primary = loadVisibleCloudAttachmentPreview({
      token: 'token',
      client,
      attachment: imagePreviewAttachment('reset-cached-preview'),
    });
    const blockers = blockerDownloads.map((_download, index) => loadVisibleCloudAttachmentPreview({
      token: 'token',
      client,
      attachment: imagePreviewAttachment(`reset-blocker-${index}`),
    }));
    const queuedDuplicate = loadVisibleCloudAttachmentPreview({
      token: 'token',
      client,
      attachment: imagePreviewAttachment('reset-cached-preview'),
    });
    const resultsPromise = Promise.allSettled([primary, ...blockers, queuedDuplicate]);

    sharedDownload.resolve(new Blob(['cached']));
    await flushMicrotasks(4);
    assert.equal(sharedDownloadCount, 1);
    assert.deepEqual(objectUrls.created, ['blob:cloud-preview-1']);

    resetCloudAttachmentPreviewLoader();
    blockerDownloads.forEach((download) => download.resolve(new Blob(['aborted'])));

    const results = await resultsPromise;
    assert.equal(results[0]?.status, 'fulfilled');
    assertAbortResult(results.at(-1));
    assert.deepEqual(objectUrls.revoked, ['blob:cloud-preview-1']);

    const reloaded = await loadVisibleCloudAttachmentPreview({
      token: 'token',
      client,
      attachment: imagePreviewAttachment('reset-cached-preview'),
    });
    assert.equal(sharedDownloadCount, 2);
    assert.equal(reloaded, 'blob:cloud-preview-2');
    resetCloudAttachmentPreviewLoader();
    assert.deepEqual(objectUrls.revoked, ['blob:cloud-preview-1', 'blob:cloud-preview-2']);
  } finally {
    blockerDownloads.forEach((download) => download.resolve(new Blob(['cleanup'])));
    resetCloudAttachmentPreviewLoader();
    objectUrls.restore();
  }
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
