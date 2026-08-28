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
  recoverCloudAttachmentPreview,
  resolveForwardAttachmentItems,
  resolveCloudMessageAttachments,
  uploadCloudFiles,
  uploadComposerAttachments,
} from '../src/features/cloud/cloudAttachments';
import type { CloudAuthClient } from '../src/features/cloud/authClient';

function imagePreviewAttachment(attachmentId: string) {
  return {
    attachmentId,
    kind: 'image' as const,
    name: `${attachmentId}.png`,
    mimeType: 'image/png',
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

function assertAbortResult(result: PromiseSettledResult<unknown> | undefined) {
  assert.equal(result?.status, 'rejected');
  if (result?.status === 'rejected') {
    assert.equal(result.reason instanceof Error ? result.reason.name : null, 'AbortError');
  }
}

function releasePreviewLease(value: unknown) {
  if (!value || typeof value !== 'object' || !('release' in value)) return;
  const release = (value as { release?: unknown }).release;
  if (typeof release === 'function') release();
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

test('cloud attachment metadata maps compressed previews but still hides original object-store URLs', () => {
  assert.deepEqual(cloudMessageAttachmentToMessageAttachment({
    attachmentId: 'att_1',
    name: 'Screenshot.png',
    kind: 'image',
    mimeType: 'image/png',
    sizeBytes: 2048,
    downloadUrl: 'https://files.test/att_1',
    previewUrl: 'data:image/webp;base64,preview',
  }), {
    kind: 'image',
    name: 'Screenshot.png',
    mimeType: 'image/png',
    sizeBytes: 2048,
    previewUrl: 'data:image/webp;base64,preview',
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
      releasePreviewLease(await loadVisibleCloudAttachmentPreview({
        token: 'token',
        client,
        attachment: imagePreviewAttachment(`preview-${index}`),
      }));
    }

    assert.deepEqual(objectUrls.revoked, ['blob:cloud-preview-1']);

    const reloaded = await loadVisibleCloudAttachmentPreview({
      token: 'token',
      client,
      attachment: imagePreviewAttachment('preview-0'),
    });

    assert.equal(reloaded?.previewUrl, `blob:cloud-preview-${CLOUD_ATTACHMENT_PREVIEW_CACHE_CAPACITY + 2}`);
    assert.equal(downloadCounts.get('preview-0'), 2);
    assert.deepEqual(objectUrls.revoked, ['blob:cloud-preview-1', 'blob:cloud-preview-2']);
    reloaded?.release();
  } finally {
    resetCloudAttachmentPreviewLoader();
    objectUrls.restore();
  }
});

test('capacity eviction defers revocation while every mounted preview holds a lease', async () => {
  const objectUrls = installObjectUrlSpies();
  const leases: unknown[] = [];
  const client = {
    async downloadAttachmentContent(_token: string, attachmentId: string) {
      return new Blob([attachmentId]);
    },
  } as Pick<CloudAuthClient, 'downloadAttachmentContent'>;

  try {
    for (let index = 0; index <= CLOUD_ATTACHMENT_PREVIEW_CACHE_CAPACITY; index += 1) {
      const lease = await loadVisibleCloudAttachmentPreview({
        token: 'token',
        client,
        attachment: imagePreviewAttachment(`mounted-preview-${index}`),
      });
      assert.ok(lease);
      leases.push(lease);
    }

    assert.deepEqual(objectUrls.revoked, [], 'LRU eviction must not revoke a mounted preview');
    const oldestLease = leases[0] as { previewUrl: string; release(): void };
    assert.equal(oldestLease.previewUrl, 'blob:cloud-preview-1');
    oldestLease.release();
    assert.deepEqual(objectUrls.revoked, ['blob:cloud-preview-1']);
  } finally {
    leases.forEach(releasePreviewLease);
    resetCloudAttachmentPreviewLoader();
    objectUrls.restore();
  }
});

test('duplicate preview callers receive independent leases for the retained URL', async () => {
  const objectUrls = installObjectUrlSpies();
  const leases: unknown[] = [];
  let sharedDownloads = 0;
  const client = {
    async downloadAttachmentContent(_token: string, attachmentId: string) {
      if (attachmentId === 'independent-shared-preview') sharedDownloads += 1;
      return new Blob([attachmentId]);
    },
  } as Pick<CloudAuthClient, 'downloadAttachmentContent'>;

  try {
    const first = await loadVisibleCloudAttachmentPreview({
      token: 'token',
      client,
      attachment: imagePreviewAttachment('independent-shared-preview'),
    });
    const second = await loadVisibleCloudAttachmentPreview({
      token: 'token',
      client,
      attachment: imagePreviewAttachment('independent-shared-preview'),
    });
    assert.ok(first);
    assert.ok(second);
    leases.push(first, second);

    for (let index = 0; index < CLOUD_ATTACHMENT_PREVIEW_CACHE_CAPACITY; index += 1) {
      const lease = await loadVisibleCloudAttachmentPreview({
        token: 'token',
        client,
        attachment: imagePreviewAttachment(`independent-fill-${index}`),
      });
      releasePreviewLease(lease);
    }

    assert.equal((first as { previewUrl: string }).previewUrl, 'blob:cloud-preview-1');
    assert.equal((second as { previewUrl: string }).previewUrl, 'blob:cloud-preview-1');
    assert.equal(sharedDownloads, 1);
    assert.deepEqual(objectUrls.revoked, []);
    (first as { release(): void }).release();
    assert.deepEqual(objectUrls.revoked, [], 'one lease must keep the shared URL alive');
    (second as { release(): void }).release();
    assert.deepEqual(objectUrls.revoked, ['blob:cloud-preview-1']);
  } finally {
    leases.forEach(releasePreviewLease);
    resetCloudAttachmentPreviewLoader();
    objectUrls.restore();
  }
});

test('reset before cached lease publication rejects without leaking or fulfilling a revoked URL', async () => {
  const objectUrls = installObjectUrlSpies();
  const client = {
    async downloadAttachmentContent() {
      return new Blob(['cached']);
    },
  } as Pick<CloudAuthClient, 'downloadAttachmentContent'>;

  try {
    const seededLease = await loadVisibleCloudAttachmentPreview({
      token: 'token',
      client,
      attachment: imagePreviewAttachment('reset-before-publication'),
    });
    releasePreviewLease(seededLease);
    const request = loadVisibleCloudAttachmentPreview({
      token: 'token',
      client,
      attachment: imagePreviewAttachment('reset-before-publication'),
    });
    const resultPromise = Promise.allSettled([request]);

    resetCloudAttachmentPreviewLoader();

    const [result] = await resultPromise;
    assertAbortResult(result);
    assert.deepEqual(objectUrls.revoked, ['blob:cloud-preview-1']);
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
      releasePreviewLease(await loadVisibleCloudAttachmentPreview({
        token: 'token',
        client,
        attachment: imagePreviewAttachment(`preview-${index}`),
      }));
    }
    const recentlyUsed = await loadVisibleCloudAttachmentPreview({
      token: 'token',
      client,
      attachment: imagePreviewAttachment('preview-0'),
    });
    releasePreviewLease(await loadVisibleCloudAttachmentPreview({
      token: 'token',
      client,
      attachment: imagePreviewAttachment(`preview-${CLOUD_ATTACHMENT_PREVIEW_CACHE_CAPACITY}`),
    }));

    assert.equal(recentlyUsed?.previewUrl, 'blob:cloud-preview-1');
    recentlyUsed?.release();
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
    const firstLease = await first;
    releases[1]?.(new Blob(['second']));
    const secondLease = await second;

    assert.equal(firstLease?.previewUrl, 'blob:cloud-preview-1');
    assert.equal(secondLease?.previewUrl, firstLease?.previewUrl);
    assert.deepEqual(objectUrls.revoked, ['blob:cloud-preview-2']);
    firstLease?.release();
    secondLease?.release();

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
    assert.equal(reloaded?.previewUrl, 'blob:cloud-preview-2');
    reloaded?.release();
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
    assert.deepEqual(objectUrls.revoked, []);
    if (results[0]?.status === 'fulfilled') releasePreviewLease(results[0].value);
    assert.deepEqual(objectUrls.revoked, ['blob:cloud-preview-1']);

    const reloaded = await loadVisibleCloudAttachmentPreview({
      token: 'token',
      client,
      attachment: imagePreviewAttachment('reset-cached-preview'),
    });
    assert.equal(sharedDownloadCount, 2);
    assert.equal(reloaded?.previewUrl, 'blob:cloud-preview-2');
    reloaded?.release();
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

test('resolveForwardAttachmentItems reuses a local image path without downloading it', async () => {
  const result = await resolveForwardAttachmentItems({
    token: 'kordi_cs_xyz',
    client: {
      async downloadAttachmentContent() {
        throw new Error('local forwarding should not download');
      },
    },
    attachments: [{
      attachmentId: 'att_local_forward',
      name: 'local.png',
      kind: 'image',
      mimeType: 'image/png',
      localPath: '/tmp/local.png',
    }],
  });

  assert.equal(result[0]?.id, 'att_local_forward');
  assert.equal(result[0]?.path, '/tmp/local.png');
});

test('resolveForwardAttachmentItems downloads a remote image even when its size is unknown', async () => {
  const downloaded: string[] = [];
  const stored: string[] = [];
  const result = await resolveForwardAttachmentItems({
    token: 'kordi_cs_xyz',
    client: {
      async downloadAttachmentContent(_token: string, attachmentId: string) {
        downloaded.push(attachmentId);
        return new Blob([new Uint8Array([9, 8, 7])], { type: 'image/png' });
      },
    },
    attachments: [{
      attachmentId: 'att_remote_forward_unknown_size',
      name: 'remote.png',
      kind: 'image',
      mimeType: 'image/png',
      sizeBytes: null,
    }],
    storeAttachment: async (name) => {
      stored.push(name);
      return '/tmp/forward-cache/remote.png';
    },
  });

  assert.deepEqual(downloaded, ['att_remote_forward_unknown_size']);
  assert.deepEqual(stored, ['remote.png']);
  assert.equal(result[0]?.path, '/tmp/forward-cache/remote.png');
});

test('resolveForwardAttachmentItems reports an unavailable original instead of sending a placeholder', async () => {
  await assert.rejects(
    resolveForwardAttachmentItems({
      token: 'kordi_cs_xyz',
      client: {
        async downloadAttachmentContent() {
          throw new Error('not reachable');
        },
      },
      attachments: [{
        attachmentId: 'att_missing_forward',
        name: 'missing.png',
        kind: 'image',
        mimeType: 'image/png',
      }],
      storeAttachment: async () => '/tmp/never-used.png',
    }),
    /Unable to forward “missing\.png”/,
  );
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

test('recoverCloudAttachmentPreview downloads old image attachments and persists compressed previews', async () => {
  const events: string[] = [];
  const client = {
    async downloadAttachmentContent(_token: string, attachmentId: string) {
      events.push(`download:${attachmentId}`);
      return new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' });
    },
    async updateAttachmentPreview(_token: string, attachmentId: string, previewUrl: string) {
      events.push(`update:${attachmentId}:${previewUrl}`);
      return {
        attachmentId,
        previewUrl,
        updatedLinks: 2,
      };
    },
  } as Pick<CloudAuthClient, 'downloadAttachmentContent' | 'updateAttachmentPreview'>;

  const previewUrl = await recoverCloudAttachmentPreview({
    token: 'kordi_cs_xyz',
    client,
    attachment: {
      attachmentId: 'att_old_image',
      name: 'old.png',
      kind: 'image',
      mimeType: 'image/png',
      sizeBytes: 24 * 1024 * 1024,
      previewUrl: null,
    },
    createPreviewDataUrl: async (blob) => {
      events.push(`preview:${blob.type}:${blob.size}`);
      return 'data:image/webp;base64,recovered-preview';
    },
  });

  assert.equal(previewUrl, 'data:image/webp;base64,recovered-preview');
  assert.deepEqual(events, [
    'download:att_old_image',
    'preview:image/png:4',
    'update:att_old_image:data:image/webp;base64,recovered-preview',
  ]);
});

test('recoverCloudAttachmentPreview skips attachments that already have a preview', async () => {
  let called = false;
  const client = {
    async downloadAttachmentContent() {
      called = true;
      return new Blob();
    },
    async updateAttachmentPreview() {
      called = true;
      return { attachmentId: 'att_1', previewUrl: '', updatedLinks: 0 };
    },
  } as unknown as Pick<CloudAuthClient, 'downloadAttachmentContent' | 'updateAttachmentPreview'>;

  const previewUrl = await recoverCloudAttachmentPreview({
    token: 'kordi_cs_xyz',
    client,
    attachment: {
      attachmentId: 'att_existing',
      name: 'existing.png',
      kind: 'image',
      mimeType: 'image/png',
      sizeBytes: 24,
      previewUrl: 'data:image/webp;base64,existing',
    },
  });

  assert.equal(previewUrl, null);
  assert.equal(called, false);
});

test('uploadComposerAttachments creates the compressed preview before uploading the original image', async () => {
  const events: string[] = [];
  const client = {
    async uploadAttachment(_token: string, blob: Blob) {
      events.push('upload');
      assert.equal(blob.type, 'image/png');
      return {
        attachmentId: 'att_ordered_image',
        objectKey: 'attachments/acct/att_ordered_image',
        sizeBytes: blob.size,
        contentType: blob.type,
        sha256Hex: null,
        finalizedAt: '2026-05-12T00:00:00Z',
      };
    },
  } as Pick<CloudAuthClient, 'uploadAttachment'>;

  await uploadComposerAttachments({
    token: 'kordi_cs_xyz',
    client,
    attachments: [{
      id: 'local-ordered',
      path: '/tmp/ordered.png',
      name: 'ordered.png',
      kind: 'image',
      mimeType: 'image/png',
      sizeBytes: 24 * 1024 * 1024,
    }],
    readAttachment: async () => {
      events.push('read');
      return [1, 2, 3, 4];
    },
    createPreviewDataUrl: async () => {
      events.push('preview');
      return 'data:image/webp;base64,compressed-preview';
    },
  });

  assert.deepEqual(events, ['read', 'preview', 'upload']);
});
