import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLOUD_MESSAGES_LEGACY_CACHE_PREFIX,
  VersionedCloudMessageCache,
  type CloudMessageCacheStore,
} from '../src/features/cloud/cloudMessageCache';
import type { CloudMessage } from '../src/features/cloud/authClient';

class MemoryCacheStore implements CloudMessageCacheStore {
  readonly values = new Map<string, unknown>();
  writes = 0;

  async get(accountId: string) { return this.values.get(accountId); }
  async set(accountId: string, value: unknown) {
    this.writes += 1;
    this.values.set(accountId, structuredClone(value));
  }
  async remove(accountId: string) { this.values.delete(accountId); }
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, String(value)); },
  };
}

const message: CloudMessage = {
  messageId: 'msg_1',
  fromAccountId: 'acct_peer',
  toAccountId: 'acct_me',
  body: 'hello',
  createdAt: '2026-07-10T00:00:00Z',
  deliveredAt: null,
  readAt: null,
  direction: 'incoming',
  attachments: [{
    attachmentId: 'att_original',
    previewAttachmentId: 'att_preview',
    name: 'photo.png',
    kind: 'image',
    mimeType: 'image/png',
    sizeBytes: 3_000_000,
    previewUrl: 'data:image/webp;base64,legacy-inline-payload',
    downloadUrl: 'https://object-store.invalid/original',
    localPath: '/tmp/private-original.png',
  }],
};

test('v2 cache imports v1 localStorage once and strips content-bearing attachment fields', async () => {
  const store = new MemoryCacheStore();
  const legacyStorage = memoryStorage();
  const key = `${CLOUD_MESSAGES_LEGACY_CACHE_PREFIX}acct_me`;
  legacyStorage.setItem(key, JSON.stringify({ acct_peer: [message] }));
  const cache = new VersionedCloudMessageCache({ store, legacyStorage, debounceMs: 0 });

  const loaded = await cache.load('acct_me');
  assert.equal(legacyStorage.getItem(key), null);
  assert.equal(loaded.acct_peer?.[0]?.attachments?.[0]?.previewAttachmentId, 'att_preview');
  assert.equal(loaded.acct_peer?.[0]?.attachments?.[0]?.previewUrl, undefined);
  assert.equal(loaded.acct_peer?.[0]?.attachments?.[0]?.downloadUrl, undefined);
  assert.equal(loaded.acct_peer?.[0]?.attachments?.[0]?.localPath, undefined);

  legacyStorage.setItem(key, JSON.stringify({ acct_peer: [{ ...message, body: 'stale legacy' }] }));
  const loadedAgain = await cache.load('acct_me');
  assert.equal(loadedAgain.acct_peer?.[0]?.body, 'hello');
});

test('v2 cache debounces and coalesces writes per account', async () => {
  const store = new MemoryCacheStore();
  const cache = new VersionedCloudMessageCache({ store, legacyStorage: null, debounceMs: 5 });

  const first = cache.save('acct_me', { acct_peer: [message] });
  const second = cache.save('acct_me', { acct_peer: [{ ...message, body: 'newest' }] });
  await Promise.all([first, second]);

  assert.equal(store.writes, 1);
  const loaded = await cache.load('acct_me');
  assert.equal(loaded.acct_peer?.[0]?.body, 'newest');
});
