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
  readonly batches: Array<{ entries: Map<string, unknown>; removeKeys: string[] }> = [];
  writes = 0;

  async get(accountId: string) { return this.values.get(accountId); }
  async getMany(keys: readonly string[]) {
    return new Map(keys.map((key) => [key, this.values.get(key)]));
  }
  async set(accountId: string, value: unknown) {
    this.writes += 1;
    this.values.set(accountId, structuredClone(value));
  }
  async setMany(entries: ReadonlyMap<string, unknown>, removeKeys: readonly string[] = []) {
    this.writes += 1;
    const clonedEntries = new Map([...entries].map(([key, value]) => [key, structuredClone(value)]));
    this.batches.push({ entries: clonedEntries, removeKeys: [...removeKeys] });
    for (const key of removeKeys) this.values.delete(key);
    for (const [key, value] of clonedEntries) this.values.set(key, value);
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

test('peer-scoped cache imports v1 localStorage once and strips content-bearing attachment fields', async () => {
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

test('peer-scoped cache migrates an existing v2 account snapshot without data loss', async () => {
  const store = new MemoryCacheStore();
  store.values.set('acct_me', {
    version: 2,
    messagesByPeer: { acct_peer: [message] },
  });
  const cache = new VersionedCloudMessageCache({ store, legacyStorage: null, debounceMs: 0 });

  const loaded = await cache.load('acct_me');

  assert.equal(loaded.acct_peer?.[0]?.body, 'hello');
  assert.equal(store.values.has('acct_me'), false);
  assert.equal(store.batches.length, 1);
  assert.ok([...store.batches[0]!.entries.values()].some((value) => (
    value && typeof value === 'object' && 'peerId' in value
  )));
});

test('peer-scoped cache debounces and coalesces writes per account', async () => {
  const store = new MemoryCacheStore();
  const cache = new VersionedCloudMessageCache({ store, legacyStorage: null, debounceMs: 5 });

  const first = cache.save('acct_me', { acct_peer: [message] });
  const second = cache.save('acct_me', { acct_peer: [{ ...message, body: 'newest' }] });
  await Promise.all([first, second]);

  assert.equal(store.writes, 1);
  const loaded = await cache.load('acct_me');
  assert.equal(loaded.acct_peer?.[0]?.body, 'newest');
});

test('peer-scoped cache writes only the changed peer after the initial snapshot', async () => {
  const store = new MemoryCacheStore();
  const cache = new VersionedCloudMessageCache({ store, legacyStorage: null, debounceMs: 0 });
  const initial = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [
    `acct_peer_${index}`,
    [{
      ...message,
      messageId: `msg_${index}`,
      fromAccountId: `acct_peer_${index}`,
    }],
  ]));
  await cache.save('acct_me', initial);

  const changedPeerId = 'acct_peer_19';
  await cache.save('acct_me', {
    ...initial,
    [changedPeerId]: [
      ...initial[changedPeerId]!,
      {
        ...message,
        messageId: 'msg_incremental',
        fromAccountId: changedPeerId,
      },
    ],
  });

  const peerRecords = [...store.batches.at(-1)!.entries.values()]
    .filter((value): value is { peerId: string } => Boolean(
      value && typeof value === 'object' && 'peerId' in value,
    ));
  assert.deepEqual(peerRecords.map((record) => record.peerId), [changedPeerId]);

  const loaded = await cache.load('acct_me');
  assert.equal(loaded[changedPeerId]?.length, 2);
  assert.equal(Object.keys(loaded).length, 20);
});
