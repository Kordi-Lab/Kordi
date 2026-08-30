import assert from 'node:assert/strict';
import test from 'node:test';

import type { CloudExpressiveMediaItem } from '../src/features/cloud/authClient';
import {
  deleteExpressiveMediaLibraryItem,
  EXPRESSIVE_MEDIA_LIBRARY_STORAGE_KEY,
  expressiveMediaLibraryStorageKey,
  readExpressiveMediaLibrary,
  synchronizeExpressiveMediaLibrary,
  writeExpressiveMediaLibrary,
  type ExpressiveMediaLibraryItem,
} from '../src/features/emoji/expressiveMediaLibrary';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  };
}

test('saved media is account-scoped and reconciles cloud items across devices', async () => {
  const { values, storage } = memoryStorage();
  const localItem: ExpressiveMediaLibraryItem = {
    id: 'local-sticker',
    attachmentId: 'attachment-local',
    kind: 'sticker',
    name: 'local.png',
    path: '/stored/local.png',
    mimeType: 'image/png',
    sizeBytes: 4,
    createdAtMs: 100,
  };
  writeExpressiveMediaLibrary([localItem], storage, 'acct-a');

  assert.equal(values.has(expressiveMediaLibraryStorageKey('acct-a')), true);
  assert.deepEqual(readExpressiveMediaLibrary(storage, 'acct-b'), []);

  const remoteItem: CloudExpressiveMediaItem = {
    itemId: 'media-remote',
    attachmentId: 'attachment-remote',
    kind: 'gif',
    name: 'remote.gif',
    mimeType: 'image/gif',
    sizeBytes: 6,
    createdAt: '2026-08-17T10:00:00Z',
    updatedAt: '2026-08-17T10:00:00Z',
  };
  let uploadCount = 0;
  const synchronized = await synchronizeExpressiveMediaLibrary({
    accountId: 'acct-a',
    token: 'token-a',
    storage,
    client: {
      listExpressiveMedia: async () => [remoteItem],
      saveExpressiveMedia: async (_token, input) => ({
        itemId: 'media-local',
        ...input,
        mimeType: 'image/png',
        sizeBytes: 4,
        createdAt: '2026-08-17T09:00:00Z',
        updatedAt: '2026-08-17T09:00:00Z',
      }),
      uploadAttachment: async () => {
        uploadCount += 1;
        throw new Error('Existing message attachments must not be uploaded again.');
      },
      downloadAttachmentContent: async () => new Blob(['GIF89a'], { type: 'image/gif' }),
    },
    storeFile: async (name) => `/stored/${name}`,
  });

  assert.equal(uploadCount, 0);
  assert.deepEqual(new Set(synchronized.map((item) => item.name)), new Set(['local.png', 'remote.gif']));
  assert.equal(synchronized.find((item) => item.name === 'local.png')?.cloudItemId, 'media-local');
  assert.equal(synchronized.find((item) => item.name === 'remote.gif')?.attachmentId, 'attachment-remote');
});

test('legacy media is claimed once even when the first account already has a library', () => {
  const { values, storage } = memoryStorage();
  const existingItem: ExpressiveMediaLibraryItem = {
    id: 'existing',
    kind: 'sticker',
    name: 'existing.png',
    path: '/stored/existing.png',
    mimeType: 'image/png',
    sizeBytes: 4,
    createdAtMs: 200,
  };
  const legacyItem = { ...existingItem, id: 'legacy', name: 'legacy.png', path: '/stored/legacy.png', createdAtMs: 100 };
  values.set(EXPRESSIVE_MEDIA_LIBRARY_STORAGE_KEY, JSON.stringify([legacyItem]));
  writeExpressiveMediaLibrary([existingItem], storage, 'acct-first');

  assert.deepEqual(readExpressiveMediaLibrary(storage, 'acct-first'), [existingItem]);
  assert.deepEqual(readExpressiveMediaLibrary(storage, 'acct-second'), []);
});

test('concurrent cloud reconciliation coalesces uploads for one account', async () => {
  const { storage } = memoryStorage();
  const accountId = 'acct-concurrent-sync';
  writeExpressiveMediaLibrary([{
    id: 'local-unsynced',
    kind: 'sticker',
    name: 'local.png',
    path: '/stored/local.png',
    mimeType: 'image/png',
    sizeBytes: 4,
    createdAtMs: 100,
  }], storage, accountId);

  let releaseList: (() => void) | undefined;
  const listGate = new Promise<void>((resolve) => { releaseList = resolve; });
  let listCount = 0;
  let uploadCount = 0;
  const client = {
    listExpressiveMedia: async () => {
      listCount += 1;
      await listGate;
      return [];
    },
    saveExpressiveMedia: async (_token: string, input: { attachmentId: string; kind: 'sticker' | 'gif'; name: string }) => ({
      itemId: 'media-local',
      ...input,
      mimeType: 'image/png',
      sizeBytes: 4,
      createdAt: '2026-08-17T09:00:00Z',
      updatedAt: '2026-08-17T09:00:00Z',
    }),
    uploadAttachment: async () => {
      uploadCount += 1;
      return {
        attachmentId: 'attachment-local',
        objectKey: 'attachments/local',
        sizeBytes: 4,
        contentType: 'image/png',
        sha256Hex: null,
        finalizedAt: '2026-08-17T09:00:00Z',
      };
    },
    downloadAttachmentContent: async () => new Blob(),
  };
  const options = {
    accountId,
    token: 'token-a',
    storage,
    client,
    readFile: async () => [0x89, 0x50, 0x4e, 0x47],
  };

  const first = synchronizeExpressiveMediaLibrary(options);
  const second = synchronizeExpressiveMediaLibrary(options);
  assert.equal(first, second);
  releaseList?.();
  await Promise.all([first, second]);

  assert.equal(listCount, 1);
  assert.equal(uploadCount, 1);
});

test('saved media deletion is durable and preserves the item when the server fails', async () => {
  const { storage } = memoryStorage();
  const accountId = 'acct-delete';
  const item: ExpressiveMediaLibraryItem = {
    id: 'local-synced',
    cloudItemId: 'media-synced',
    attachmentId: 'attachment-synced',
    kind: 'sticker',
    name: 'saved.png',
    path: '/stored/saved.png',
    mimeType: 'image/png',
    sizeBytes: 4,
    createdAtMs: 100,
  };
  writeExpressiveMediaLibrary([item], storage, accountId);

  let deletedId = '';
  const deleted = await deleteExpressiveMediaLibraryItem(item.id, {
    accountId,
    storage,
    token: 'token-a',
    client: { deleteExpressiveMedia: async (_token, mediaId) => { deletedId = mediaId; } },
  });
  assert.equal(deletedId, item.cloudItemId);
  assert.deepEqual(deleted, []);

  writeExpressiveMediaLibrary([item], storage, accountId);
  await assert.rejects(deleteExpressiveMediaLibraryItem(item.id, {
    accountId,
    storage,
    token: 'token-a',
    client: { deleteExpressiveMedia: async () => { throw new Error('offline'); } },
  }), /offline/);
  assert.deepEqual(readExpressiveMediaLibrary(storage, accountId), [item]);

  const synchronized = await synchronizeExpressiveMediaLibrary({
    accountId,
    token: 'token-a',
    storage,
    client: {
      listExpressiveMedia: async () => [],
      saveExpressiveMedia: async () => { throw new Error('Deleted media must not be saved again.'); },
      uploadAttachment: async () => { throw new Error('Deleted media must not be uploaded again.'); },
      downloadAttachmentContent: async () => new Blob(),
    },
  });
  assert.deepEqual(synchronized, []);
});
