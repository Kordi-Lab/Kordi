import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EXPRESSIVE_MEDIA_LIBRARY_STORAGE_KEY,
  EXPRESSIVE_MEDIA_MAX_BYTES,
  addFilesToExpressiveMediaLibrary,
  expressiveMediaLibraryKindForAttachment,
} from '../src/features/emoji/expressiveMediaLibrary';

test('legacy image messages match stickers already stored in an account library', () => {
  const key = `${EXPRESSIVE_MEDIA_LIBRARY_STORAGE_KEY}.account-one`;
  const values = new Map([[key, JSON.stringify([{
    id: 'sticker:/stored/wave.png', kind: 'sticker', name: 'Wave.png', path: '/stored/wave.png',
    mimeType: 'image/png', sizeBytes: 26979, createdAtMs: 123,
  }])]]);
  const storage = {
    get length() { return values.size; },
    getItem: (storageKey: string) => values.get(storageKey) ?? null,
    setItem: (storageKey: string, value: string) => values.set(storageKey, value),
    key: (index: number) => [...values.keys()][index] ?? null,
  };

  assert.equal(expressiveMediaLibraryKindForAttachment({
    name: 'wave.png', mimeType: 'image/png', sizeBytes: 26979,
  }, storage), 'sticker');
  assert.equal(expressiveMediaLibraryKindForAttachment({
    name: 'wave.png', mimeType: 'image/png', sizeBytes: 26980,
  }, storage), null);
});

test('oversized desktop stickers are normalized before storage and sync', async () => {
  const source = new File([new Uint8Array(EXPRESSIVE_MEDIA_MAX_BYTES + 1)], 'oversized.png', { type: 'image/png' });
  const compressed = new File([new Uint8Array(512)], 'oversized.webp', { type: 'image/webp' });
  let storedName = '';
  let storedBytes = 0;
  const items = await addFilesToExpressiveMediaLibrary([source], 'sticker', {
    storage: null,
    compressSticker: async (file) => {
      assert.equal(file, source);
      return compressed;
    },
    storeFile: async (name, data) => {
      storedName = name;
      storedBytes = data.length;
      return '/stored/oversized.webp';
    },
  });

  assert.equal(storedName, 'oversized.webp');
  assert.equal(storedBytes, 512);
  assert.equal(items[0]?.mimeType, 'image/webp');
  assert.equal(items[0]?.sizeBytes, 512);
});
