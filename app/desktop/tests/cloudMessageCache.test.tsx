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

class ControlledFirstWriteCacheStore extends MemoryCacheStore {
  private markFirstWriteStarted!: () => void;
  private releaseFirstWriteGate!: () => void;
  readonly firstWriteStarted = new Promise<void>((resolve) => {
    this.markFirstWriteStarted = resolve;
  });
  private readonly firstWriteRelease = new Promise<void>((resolve) => {
    this.releaseFirstWriteGate = resolve;
  });
  attempts = 0;
  activeWrites = 0;
  maxActiveWrites = 0;

  constructor(private readonly firstWriteOutcome: 'resolve' | 'reject') {
    super();
  }

  releaseFirstWrite() {
    this.releaseFirstWriteGate();
  }

  override async setMany(entries: ReadonlyMap<string, unknown>, removeKeys: readonly string[] = []) {
    const attempt = ++this.attempts;
    this.activeWrites += 1;
    this.maxActiveWrites = Math.max(this.maxActiveWrites, this.activeWrites);
    try {
      if (attempt === 1) {
        this.markFirstWriteStarted();
        await this.firstWriteRelease;
        if (this.firstWriteOutcome === 'reject') {
          throw new Error('planned first cache write failure');
        }
      }
      await super.setMany(entries, removeKeys);
    } finally {
      this.activeWrites -= 1;
    }
  }
}

class ControlledLoadFailureCacheStore extends MemoryCacheStore {
  private markPeerReadStarted!: () => void;
  private releasePeerReadGate!: () => void;
  readonly peerReadStarted = new Promise<void>((resolve) => {
    this.markPeerReadStarted = resolve;
  });
  private readonly peerReadRelease = new Promise<void>((resolve) => {
    this.releasePeerReadGate = resolve;
  });
  private shouldBlockPeerRead = false;
  private shouldRejectWrite = false;

  blockNextPeerRead() {
    this.shouldBlockPeerRead = true;
  }

  releasePeerRead() {
    this.releasePeerReadGate();
  }

  rejectNextWrite() {
    this.shouldRejectWrite = true;
  }

  override async getMany(keys: readonly string[]) {
    const values = await super.getMany(keys);
    if (this.shouldBlockPeerRead) {
      this.shouldBlockPeerRead = false;
      this.markPeerReadStarted();
      await this.peerReadRelease;
    }
    return values;
  }

  override async setMany(entries: ReadonlyMap<string, unknown>, removeKeys: readonly string[] = []) {
    if (this.shouldRejectWrite) {
      this.shouldRejectWrite = false;
      throw new Error('planned newer cache write failure');
    }
    await super.setMany(entries, removeKeys);
  }
}

class ControlledMigrationCacheStore extends MemoryCacheStore {
  private markMigrationWriteStarted!: () => void;
  private releaseMigrationWriteGate!: () => void;
  readonly migrationWriteStarted = new Promise<void>((resolve) => {
    this.markMigrationWriteStarted = resolve;
  });
  private readonly migrationWriteRelease = new Promise<void>((resolve) => {
    this.releaseMigrationWriteGate = resolve;
  });
  private shouldBlockMigrationWrite = true;

  releaseMigrationWrite() {
    this.releaseMigrationWriteGate();
  }

  override async setMany(entries: ReadonlyMap<string, unknown>, removeKeys: readonly string[] = []) {
    if (this.shouldBlockMigrationWrite) {
      this.shouldBlockMigrationWrite = false;
      this.markMigrationWriteStarted();
      await this.migrationWriteRelease;
    }
    await super.setMany(entries, removeKeys);
  }
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

test('peer-scoped cache imports v1 localStorage once, keeps bounded previews, and strips original-file fields', async () => {
  const store = new MemoryCacheStore();
  const legacyStorage = memoryStorage();
  const key = `${CLOUD_MESSAGES_LEGACY_CACHE_PREFIX}acct_me`;
  legacyStorage.setItem(key, JSON.stringify({ acct_peer: [message] }));
  const cache = new VersionedCloudMessageCache({ store, legacyStorage, debounceMs: 0 });

  const loaded = await cache.load('acct_me');
  assert.equal(legacyStorage.getItem(key), null);
  assert.equal(loaded.acct_peer?.[0]?.attachments?.[0]?.previewAttachmentId, 'att_preview');
  assert.equal(loaded.acct_peer?.[0]?.attachments?.[0]?.previewUrl, 'data:image/webp;base64,legacy-inline-payload');
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

test('peer-scoped cache recovers a failed write into the newest queued snapshot', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const store = new ControlledFirstWriteCacheStore('reject');
  const cache = new VersionedCloudMessageCache({ store, legacyStorage: null, debounceMs: 0 });
  const firstPeerMessages = [message];
  const first = cache.save('acct_me', { acct_peer: firstPeerMessages });
  context.mock.timers.runAll();
  await store.firstWriteStarted;

  const secondPeerMessage: CloudMessage = {
    ...message,
    messageId: 'msg_2',
    fromAccountId: 'acct_peer_2',
  };
  const second = cache.save('acct_me', {
    acct_peer: firstPeerMessages,
    acct_peer_2: [secondPeerMessage],
  });
  const firstFailure = assert.rejects(first, /planned first cache write failure/);
  context.mock.timers.runAll();
  store.releaseFirstWrite();

  await firstFailure;
  await second;

  const reloaded = new VersionedCloudMessageCache({ store, legacyStorage: null, debounceMs: 0 });
  const loaded = await reloaded.load('acct_me');
  assert.equal(loaded.acct_peer?.[0]?.body, 'hello');
  assert.equal(loaded.acct_peer_2?.[0]?.body, 'hello');
  assert.equal(store.maxActiveWrites, 1);
});

test('peer-scoped cache removal wins when an active write succeeds', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const store = new ControlledFirstWriteCacheStore('resolve');
  const cache = new VersionedCloudMessageCache({ store, legacyStorage: null, debounceMs: 0 });
  const first = cache.save('acct_me', { acct_peer: [message] });
  context.mock.timers.runAll();
  await store.firstWriteStarted;

  const removal = cache.remove('acct_me');
  store.releaseFirstWrite();
  await Promise.all([first, removal]);
  await cache.save('acct_me', {});

  const reloaded = new VersionedCloudMessageCache({ store, legacyStorage: null, debounceMs: 0 });
  assert.deepEqual(await reloaded.load('acct_me'), {});
});

test('peer-scoped cache removal suppresses recovery when an active write fails', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const store = new ControlledFirstWriteCacheStore('reject');
  const cache = new VersionedCloudMessageCache({ store, legacyStorage: null, debounceMs: 0 });
  const first = cache.save('acct_me', { acct_peer: [message] });
  context.mock.timers.runAll();
  await store.firstWriteStarted;

  const firstFailure = assert.rejects(first, /planned first cache write failure/);
  const removal = cache.remove('acct_me');
  store.releaseFirstWrite();
  await Promise.all([firstFailure, removal]);
  const emptySave = cache.save('acct_me', {});
  context.mock.timers.runAll();
  await emptySave;
  assert.equal(store.attempts, 2);

  const reloaded = new VersionedCloudMessageCache({ store, legacyStorage: null, debounceMs: 0 });
  assert.deepEqual(await reloaded.load('acct_me'), {});
});

test('peer-scoped cache load discards stale recovery after a rejected save', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const store = new ControlledFirstWriteCacheStore('reject');
  const cache = new VersionedCloudMessageCache({ store, legacyStorage: null, debounceMs: 0 });
  const first = cache.save('acct_me', { acct_peer: [message] });
  context.mock.timers.runAll();
  await store.firstWriteStarted;

  const firstFailure = assert.rejects(first, /planned first cache write failure/);
  store.releaseFirstWrite();
  await firstFailure;
  assert.deepEqual(await cache.load('acct_me'), {});
  const emptySave = cache.save('acct_me', {});
  context.mock.timers.runAll();
  await emptySave;
  assert.equal(store.attempts, 2);

  const reloaded = new VersionedCloudMessageCache({ store, legacyStorage: null, debounceMs: 0 });
  assert.deepEqual(await reloaded.load('acct_me'), {});
});

test('peer-scoped cache load preserves a newer failed-save baseline', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const store = new ControlledLoadFailureCacheStore();
  const cache = new VersionedCloudMessageCache({ store, legacyStorage: null, debounceMs: 0 });
  const initialSave = cache.save('acct_me', { acct_peer: [message] });
  context.mock.timers.runAll();
  await initialSave;

  store.blockNextPeerRead();
  const loading = cache.load('acct_me');
  await store.peerReadStarted;
  store.rejectNextWrite();
  const failedRemoval = cache.save('acct_me', {});
  context.mock.timers.runAll();
  await assert.rejects(failedRemoval, /planned newer cache write failure/);
  store.releasePeerRead();

  const loaded = await loading;
  assert.equal(loaded.acct_peer?.[0]?.body, 'hello');
  const restoreLoadedSnapshot = cache.save('acct_me', loaded);
  context.mock.timers.runAll();
  await restoreLoadedSnapshot;

  const reloaded = new VersionedCloudMessageCache({ store, legacyStorage: null, debounceMs: 0 });
  assert.equal((await reloaded.load('acct_me')).acct_peer?.[0]?.body, 'hello');
});

test('peer-scoped cache load cannot replace a newer successful-save baseline', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const store = new ControlledLoadFailureCacheStore();
  const cache = new VersionedCloudMessageCache({ store, legacyStorage: null, debounceMs: 0 });
  const initialSave = cache.save('acct_me', { acct_peer: [message] });
  context.mock.timers.runAll();
  await initialSave;

  store.blockNextPeerRead();
  const loading = cache.load('acct_me');
  await store.peerReadStarted;
  const newestSnapshot = { acct_peer: [{ ...message, body: 'newest' }] };
  const newerSave = cache.save('acct_me', newestSnapshot);
  context.mock.timers.runAll();
  await newerSave;
  store.releasePeerRead();
  assert.equal((await loading).acct_peer?.[0]?.body, 'hello');

  const redundantSave = cache.save('acct_me', newestSnapshot);
  context.mock.timers.runAll();
  await redundantSave;
  assert.equal(store.batches.length, 2, 'the stale load must not make an already-durable save look changed');

  const reloaded = new VersionedCloudMessageCache({ store, legacyStorage: null, debounceMs: 0 });
  assert.equal((await reloaded.load('acct_me')).acct_peer?.[0]?.body, 'newest');
});

test('peer-scoped cache removal cancels a blocked v3 load baseline', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const store = new ControlledLoadFailureCacheStore();
  const cache = new VersionedCloudMessageCache({ store, legacyStorage: null, debounceMs: 0 });
  const initialSave = cache.save('acct_me', { acct_peer: [message] });
  context.mock.timers.runAll();
  await initialSave;

  store.blockNextPeerRead();
  const loading = cache.load('acct_me');
  await store.peerReadStarted;
  const removal = cache.remove('acct_me');
  store.releasePeerRead();

  const [loaded] = await Promise.all([loading, removal]);
  assert.deepEqual(loaded, {});
  const reloaded = new VersionedCloudMessageCache({ store, legacyStorage: null, debounceMs: 0 });
  assert.deepEqual(await reloaded.load('acct_me'), {});
});

test('peer-scoped cache removal deletes a blocked v2 migration write', async () => {
  const store = new ControlledMigrationCacheStore();
  store.values.set('acct_me', {
    version: 2,
    messagesByPeer: { acct_peer: [message] },
  });
  const cache = new VersionedCloudMessageCache({ store, legacyStorage: null, debounceMs: 0 });
  const loading = cache.load('acct_me');
  await store.migrationWriteStarted;

  const removal = cache.remove('acct_me');
  await Promise.resolve();
  store.releaseMigrationWrite();

  const [loaded] = await Promise.all([loading, removal]);
  assert.deepEqual(loaded, {});
  const reloaded = new VersionedCloudMessageCache({ store, legacyStorage: null, debounceMs: 0 });
  assert.deepEqual(await reloaded.load('acct_me'), {});
});
