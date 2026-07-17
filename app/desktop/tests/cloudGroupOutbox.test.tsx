import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CloudGroupOutbox,
  CLOUD_GROUP_CANONICAL_RECONCILE_DELAY_MS,
  cloudGroupOutboxDeliveryStatus,
  cloudGroupOutboxNextWakeAtMs,
  defaultCloudGroupOutboxPersistence,
  patchCanonicalCloudGroupOutboxDelivery,
  type CloudGroupOutboxPersistedState,
  type CloudGroupOutboxPersistence,
} from '../src/features/cloud/cloudGroupOutbox';
import { encodeCloudGroupControl, parseCloudGroupControl } from '../src/features/cloud/cloudGroupMessages';
import { prepareCloudGroupOutboxEntryAttachments } from '../src/features/cloud/useCloudBridgeState';
import type { CanonicalSessionState } from '../src/kordi-app/types';

class MemoryPersistence implements CloudGroupOutboxPersistence {
  value: CloudGroupOutboxPersistedState | null = null;
  private failuresRemaining = 0;

  async load() { return this.value ? structuredClone(this.value) : null; }
  async save(value: CloudGroupOutboxPersistedState) {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error('forced persistence failure');
    }
    this.value = structuredClone(value);
  }
  failNextSave() { this.failuresRemaining += 1; }
}

class ControlledFirstSaveFailurePersistence extends MemoryPersistence {
  private saveCount = 0;
  private resolveFirstSaveStarted: (() => void) | null = null;
  private resolveFirstSaveRelease: (() => void) | null = null;
  readonly firstSaveStarted = new Promise<void>((resolve) => { this.resolveFirstSaveStarted = resolve; });
  private readonly firstSaveRelease = new Promise<void>((resolve) => { this.resolveFirstSaveRelease = resolve; });

  override async save(value: CloudGroupOutboxPersistedState) {
    this.saveCount += 1;
    if (this.saveCount === 1) {
      this.resolveFirstSaveStarted?.();
      await this.firstSaveRelease;
      throw new Error('forced first save failure');
    }
    await super.save(value);
  }

  releaseFirstSave() { this.resolveFirstSaveRelease?.(); }
}

class ControlledFirstSaveSuccessPersistence extends MemoryPersistence {
  saveCount = 0;
  private resolveFirstSaveStarted: (() => void) | null = null;
  private resolveFirstSaveRelease: (() => void) | null = null;
  readonly firstSaveStarted = new Promise<void>((resolve) => { this.resolveFirstSaveStarted = resolve; });
  private readonly firstSaveRelease = new Promise<void>((resolve) => { this.resolveFirstSaveRelease = resolve; });

  override async save(value: CloudGroupOutboxPersistedState) {
    this.saveCount += 1;
    if (this.saveCount === 1) {
      this.resolveFirstSaveStarted?.();
      await this.firstSaveRelease;
    }
    await super.save(value);
  }

  releaseFirstSave() { this.resolveFirstSaveRelease?.(); }
}

class ControlledFirstSuccessSecondFailurePersistence extends MemoryPersistence {
  private saveCount = 0;
  private resolveFirstSaveStarted: (() => void) | null = null;
  private resolveFirstSaveRelease: (() => void) | null = null;
  readonly firstSaveStarted = new Promise<void>((resolve) => { this.resolveFirstSaveStarted = resolve; });
  private readonly firstSaveRelease = new Promise<void>((resolve) => { this.resolveFirstSaveRelease = resolve; });

  override async save(value: CloudGroupOutboxPersistedState) {
    this.saveCount += 1;
    if (this.saveCount === 1) {
      this.resolveFirstSaveStarted?.();
      await this.firstSaveRelease;
      await super.save(value);
      return;
    }
    if (this.saveCount === 2) throw new Error('forced second save failure');
    await super.save(value);
  }

  releaseFirstSave() { this.resolveFirstSaveRelease?.(); }
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  failRemovals = false;

  constructor(private readonly events: string[] = []) {}

  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) {
    this.events.push('storage-remove');
    if (this.failRemovals) throw new Error('forced localStorage cleanup failure');
    this.values.delete(key);
  }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

type FakeRequest<T> = {
  result: T;
  error: DOMException | null;
  onsuccess: ((this: IDBRequest<T>, event: Event) => unknown) | null;
  onerror: ((this: IDBRequest<T>, event: Event) => unknown) | null;
};

type FakeTransaction = {
  oncomplete: ((this: IDBTransaction, event: Event) => unknown) | null;
  onabort: ((this: IDBTransaction, event: Event) => unknown) | null;
  onerror: ((this: IDBTransaction, event: Event) => unknown) | null;
  objectStore(name: string): IDBObjectStore;
};

class ControllableIndexedDb {
  failWrites = false;
  value: CloudGroupOutboxPersistedState | undefined;
  readonly factory: IDBFactory;

  constructor(value: CloudGroupOutboxPersistedState | undefined, private readonly events: string[]) {
    this.value = value ? structuredClone(value) : undefined;
    const database = {
      objectStoreNames: { contains: () => true },
      transaction: (_name: string, _mode: IDBTransactionMode) => this.transaction(),
    } as unknown as IDBDatabase;
    this.factory = {
      open: () => {
        const request: FakeRequest<IDBDatabase> = {
          result: database,
          error: null,
          onsuccess: null,
          onerror: null,
        };
        queueMicrotask(() => {
          request.onsuccess?.call(request as unknown as IDBRequest<IDBDatabase>, new Event('success'));
        });
        return request as unknown as IDBOpenDBRequest;
      },
    } as unknown as IDBFactory;
  }

  private transaction(): IDBTransaction {
    const transaction: FakeTransaction = {
      oncomplete: null,
      onabort: null,
      onerror: null,
      objectStore: () => ({
        get: () => {
          const request: FakeRequest<CloudGroupOutboxPersistedState | undefined> = {
            result: undefined,
            error: null,
            onsuccess: null,
            onerror: null,
          };
          queueMicrotask(() => {
            request.result = this.value ? structuredClone(this.value) : undefined;
            request.onsuccess?.call(
              request as unknown as IDBRequest<CloudGroupOutboxPersistedState | undefined>,
              new Event('success'),
            );
            queueMicrotask(() => {
              transaction.oncomplete?.call(transaction as unknown as IDBTransaction, new Event('complete'));
            });
          });
          return request as unknown as IDBRequest<unknown>;
        },
        put: (value: CloudGroupOutboxPersistedState) => {
          const request: FakeRequest<IDBValidKey> = {
            result: 'acct_me',
            error: null,
            onsuccess: null,
            onerror: null,
          };
          queueMicrotask(() => {
            if (this.failWrites) {
              request.error = new DOMException('forced IndexedDB write failure');
              request.onerror?.call(request as unknown as IDBRequest<IDBValidKey>, new Event('error'));
              return;
            }
            request.onsuccess?.call(request as unknown as IDBRequest<IDBValidKey>, new Event('success'));
            queueMicrotask(() => {
              this.value = structuredClone(value);
              this.events.push('idb-put-complete');
              transaction.oncomplete?.call(transaction as unknown as IDBTransaction, new Event('complete'));
            });
          });
          return request as unknown as IDBRequest<IDBValidKey>;
        },
      } as unknown as IDBObjectStore),
    };
    return transaction as unknown as IDBTransaction;
  }
}

async function withBrowserPersistenceGlobals<T>(
  factory: IDBFactory | undefined,
  storage: Storage | undefined,
  run: () => Promise<T>,
) {
  const indexedDbDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: factory });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: storage ? { localStorage: storage } : undefined,
  });
  try {
    return await run();
  } finally {
    if (indexedDbDescriptor) Object.defineProperty(globalThis, 'indexedDB', indexedDbDescriptor);
    else Reflect.deleteProperty(globalThis, 'indexedDB');
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

function entry() {
  return {
    canonicalMessageId: 'msg:canonical:one',
    sessionId: 'session:group:one',
    envelope: 'encoded-envelope',
    pendingRecipientIds: ['acct_a', 'acct_b'],
    deliveredRecipientIds: [],
    attemptsByRecipientId: {},
    nextAttemptAtMs: 0,
  };
}

function awaitingEntry(canonicalMessageId: string) {
  return {
    ...entry(),
    canonicalMessageId,
    awaitingCanonicalAck: true,
    pendingRecipientIds: [],
    deliveredRecipientIds: ['acct_a', 'acct_b'],
  };
}

test('outbox schedules canonical acknowledgement replay without resending recipients', () => {
  const nowMs = 500;
  assert.equal(
    cloudGroupOutboxNextWakeAtMs([awaitingEntry('msg:canonical:awaiting')], nowMs),
    nowMs + CLOUD_GROUP_CANONICAL_RECONCILE_DELAY_MS,
  );
  assert.equal(cloudGroupOutboxNextWakeAtMs([{ ...entry(), nextAttemptAtMs: 1_100 }], nowMs), 1_100);
  assert.equal(cloudGroupOutboxNextWakeAtMs([{
    ...entry(),
    pendingRecipientIds: [],
    exhaustedRecipientIds: ['acct_a', 'acct_b'],
  }], nowMs), null);
});

test('outbox keeps image previews in attachment metadata for recipient delivery', async () => {
  const persistence = new MemoryPersistence();
  const outbox = new CloudGroupOutbox('acct_me', persistence);
  await outbox.restore();
  const previewUrl = 'data:image/webp;base64,preview';

  await outbox.enqueue({
    ...entry(),
    attachments: [{
      attachmentId: 'att_preview',
      name: 'image.png',
      kind: 'image',
      mimeType: 'image/png',
      sizeBytes: 42,
      previewUrl,
    }],
  });

  assert.equal(outbox.entries()[0]?.attachments?.[0]?.previewUrl, previewUrl);
  assert.equal(persistence.value?.entries[0]?.attachments?.[0]?.previewUrl, previewUrl);
});

test('outbox durably retains local attachment sources until upload completes', async () => {
  const persistence = new MemoryPersistence();
  const first = new CloudGroupOutbox('acct_me', persistence);
  await first.restore();
  await first.enqueue({
    ...entry(),
    pendingAttachments: [{
      id: 'local_image',
      path: '/tmp/kordi/image.png',
      name: 'image.png',
      kind: 'image',
      mimeType: 'image/png',
      sizeBytes: 42,
    }],
  });

  const restarted = new CloudGroupOutbox('acct_me', persistence);
  const [restored] = await restarted.restore();
  assert.deepEqual(restored?.pendingAttachments, [{
    id: 'local_image',
    path: '/tmp/kordi/image.png',
    name: 'image.png',
    kind: 'image',
    formatLabel: null,
    mimeType: 'image/png',
    sizeBytes: 42,
  }]);
  assert.equal(restored?.attachments, undefined);

  await restarted.completeAttachmentUpload('msg:canonical:one', {
    envelope: 'encoded-envelope-with-attachment-reference',
    attachments: [{
      attachmentId: 'att_uploaded',
      name: 'image.png',
      kind: 'image',
      mimeType: 'image/png',
      sizeBytes: 42,
      previewUrl: 'data:image/webp;base64,preview',
    }],
  });

  const completed = new CloudGroupOutbox('acct_me', persistence);
  const [uploaded] = await completed.restore();
  assert.equal(uploaded?.envelope, 'encoded-envelope-with-attachment-reference');
  assert.equal(uploaded?.pendingAttachments, undefined);
  assert.equal(uploaded?.attachments?.[0]?.attachmentId, 'att_uploaded');
});

test('failed attachment payload persistence leaves the pre-upload outbox recoverable', async () => {
  const persistence = new MemoryPersistence();
  const outbox = new CloudGroupOutbox('acct_me', persistence);
  await outbox.restore();
  await outbox.enqueue({
    ...entry(),
    pendingAttachments: [{
      id: 'local_image',
      path: '/tmp/kordi/image.png',
      name: 'image.png',
      kind: 'image',
    }],
  });
  persistence.failNextSave();

  await assert.rejects(
    outbox.completeAttachmentUpload('msg:canonical:one', {
      envelope: 'encoded-envelope-with-attachment-reference',
      attachments: [{
        attachmentId: 'att_uploaded',
        name: 'image.png',
        kind: 'image',
      }],
    }),
    /forced persistence failure/,
  );

  assert.equal(outbox.entries()[0]?.envelope, 'encoded-envelope');
  assert.equal(outbox.entries()[0]?.attachments, undefined);
  assert.equal(outbox.entries()[0]?.pendingAttachments?.[0]?.path, '/tmp/kordi/image.png');
  const restarted = new CloudGroupOutbox('acct_me', persistence);
  assert.equal((await restarted.restore())[0]?.pendingAttachments?.[0]?.path, '/tmp/kordi/image.png');
});

test('attachment preparation retries upload from the durable source before recipient delivery', async () => {
  const persistence = new MemoryPersistence();
  const outbox = new CloudGroupOutbox('acct_me', persistence);
  await outbox.restore();
  const envelope = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:one',
    groupTitle: null,
    createdByAccountId: 'acct_me',
    actor: { accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'person' },
    participants: [{ accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'person' }],
    message: {
      id: 'msg:canonical:one',
      senderAccountId: 'acct_me',
      text: 'image',
      createdAtMs: 100,
    },
  });
  const queued = await outbox.enqueue({
    ...entry(),
    envelope,
    pendingAttachments: [{
      id: 'local_image',
      path: '/tmp/kordi/image.png',
      name: 'image.png',
      kind: 'image',
    }],
  });
  assert.ok(queued);

  await assert.rejects(
    prepareCloudGroupOutboxEntryAttachments({
      outbox,
      entry: queued,
      upload: async () => { throw new Error('offline during upload'); },
    }),
    /offline during upload/,
  );
  assert.equal(outbox.entries()[0]?.pendingAttachments?.[0]?.path, '/tmp/kordi/image.png');

  const prepared = await prepareCloudGroupOutboxEntryAttachments({
    outbox,
    entry: outbox.entries()[0]!,
    upload: async (sources) => {
      assert.equal(sources[0]?.path, '/tmp/kordi/image.png');
      return [{
        attachmentId: 'att_uploaded',
        name: 'image.png',
        kind: 'image',
      }];
    },
  });

  assert.equal(prepared.pendingAttachments, undefined);
  assert.equal(prepared.attachments?.[0]?.attachmentId, 'att_uploaded');
  assert.equal(parseCloudGroupControl(prepared.envelope)?.message?.attachments?.[0]?.attachmentId, 'att_uploaded');
  assert.equal(persistence.value?.entries[0]?.pendingAttachments, undefined);
});

test('upload failure sends no recipient payload and restart resumes the complete image delivery', async () => {
  const persistence = new MemoryPersistence();
  const first = new CloudGroupOutbox('acct_me', persistence);
  await first.restore();
  const envelope = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:one',
    groupTitle: null,
    createdByAccountId: 'acct_me',
    actor: { accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'person' },
    participants: [{ accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'person' }],
    message: {
      id: 'msg:canonical:one',
      senderAccountId: 'acct_me',
      text: '',
      createdAtMs: 100,
    },
  });
  await first.enqueue({
    ...entry(),
    envelope,
    pendingAttachments: [{
      id: 'local_image',
      path: '/tmp/kordi/image.png',
      name: 'image.png',
      kind: 'image',
    }],
  });

  let firstPreparation: Promise<ReturnType<CloudGroupOutbox['entries']>[number]> | null = null;
  let uploadAttempts = 0;
  let recipientSends = 0;
  const failedOutcome = await first.deliver('msg:canonical:one', async ({ entry: deliveryEntry }) => {
    firstPreparation ??= prepareCloudGroupOutboxEntryAttachments({
      outbox: first,
      entry: deliveryEntry,
      upload: async () => {
        uploadAttempts += 1;
        throw new Error('offline during upload');
      },
    });
    await firstPreparation;
    recipientSends += 1;
  }, { nowMs: 100, force: true });

  assert.equal(uploadAttempts, 1, 'all recipients must share one attachment upload attempt');
  assert.equal(recipientSends, 0, 'no recipient transport may run without an uploaded attachment payload');
  assert.deepEqual(failedOutcome?.pendingRecipientIds, ['acct_a', 'acct_b']);
  assert.equal(failedOutcome?.attemptsByRecipientId.acct_a, 1);
  assert.equal(failedOutcome?.pendingAttachments?.[0]?.path, '/tmp/kordi/image.png');

  const restarted = new CloudGroupOutbox('acct_me', persistence);
  await restarted.restore();
  let resumedPreparation: Promise<ReturnType<CloudGroupOutbox['entries']>[number]> | null = null;
  const deliveredRecipientIds: string[] = [];
  await restarted.deliverDue(async ({ recipientId, entry: deliveryEntry }) => {
    resumedPreparation ??= prepareCloudGroupOutboxEntryAttachments({
      outbox: restarted,
      entry: deliveryEntry,
      upload: async () => [{
        attachmentId: 'att_uploaded_after_restart',
        name: 'image.png',
        kind: 'image',
        previewUrl: 'data:image/webp;base64,preview',
      }],
    });
    const ready = await resumedPreparation;
    assert.equal(ready.attachments?.[0]?.attachmentId, 'att_uploaded_after_restart');
    assert.equal(parseCloudGroupControl(ready.envelope)?.message?.attachments?.[0]?.attachmentId, 'att_uploaded_after_restart');
    deliveredRecipientIds.push(recipientId);
  }, 1_100);

  assert.deepEqual(deliveredRecipientIds.sort(), ['acct_a', 'acct_b']);
  assert.equal(restarted.entries()[0]?.awaitingCanonicalAck, true);
});

test('restart prefers a completed uploaded payload over a stale fallback source snapshot', async () => {
  const events: string[] = [];
  const storage = new MemoryStorage(events);
  const indexedDb = new ControllableIndexedDb({
    version: 1,
    entries: [{
      ...entry(),
      envelope: 'uploaded-envelope',
      payloadVersion: 1,
      attachments: [{
        attachmentId: 'att_uploaded',
        name: 'image.png',
        kind: 'image',
      }],
    }],
    completedCanonicalMessageIds: [],
  }, events);
  storage.setItem('kordi.cloud.groupOutbox.v1:acct_me', JSON.stringify({
    version: 1,
    entries: [{
      ...entry(),
      envelope: 'pre-upload-envelope',
      payloadVersion: 0,
      pendingAttachments: [{
        id: 'local_image',
        path: '/tmp/kordi/image.png',
        name: 'image.png',
        kind: 'image',
      }],
    }],
    completedCanonicalMessageIds: [],
  }));

  await withBrowserPersistenceGlobals(indexedDb.factory, storage, async () => {
    const restarted = new CloudGroupOutbox('acct_me', defaultCloudGroupOutboxPersistence('acct_me'));
    const [restored] = await restarted.restore();
    assert.equal(restored?.envelope, 'uploaded-envelope');
    assert.equal(restored?.pendingAttachments, undefined);
    assert.equal(restored?.attachments?.[0]?.attachmentId, 'att_uploaded');
  });
});

test('fallback reconciliation preserves the newest manual retry payload version', async () => {
  const pendingRetryEntry = {
    ...entry(),
    envelope: 'manual-retry-envelope',
    payloadVersion: 2,
    deliveryGeneration: 2,
    pendingRecipientIds: ['acct_b'],
    deliveredRecipientIds: ['acct_a'],
    attemptsByRecipientId: { acct_b: 0 },
    pendingAttachments: [{
      id: 'local_retry_image',
      path: '/tmp/kordi/retry.png',
      name: 'retry.png',
      kind: 'image' as const,
    }],
  };
  const previouslyUploadedEntry = {
    ...entry(),
    envelope: 'previous-upload-envelope',
    payloadVersion: 1,
    deliveryGeneration: 1,
    pendingRecipientIds: [],
    deliveredRecipientIds: ['acct_a'],
    exhaustedRecipientIds: ['acct_b'],
    attemptsByRecipientId: { acct_b: 6 },
    attachments: [{
      attachmentId: 'att_previous',
      name: 'previous.png',
      kind: 'image' as const,
    }],
  };

  for (const [indexedDbEntry, fallbackEntry] of [
    [previouslyUploadedEntry, pendingRetryEntry],
    [pendingRetryEntry, previouslyUploadedEntry],
  ] as const) {
    const events: string[] = [];
    const storage = new MemoryStorage(events);
    const indexedDb = new ControllableIndexedDb({
      version: 1,
      entries: [indexedDbEntry],
      completedCanonicalMessageIds: [],
    }, events);
    storage.setItem('kordi.cloud.groupOutbox.v1:acct_me', JSON.stringify({
      version: 1,
      entries: [fallbackEntry],
      completedCanonicalMessageIds: [],
    }));

    await withBrowserPersistenceGlobals(indexedDb.factory, storage, async () => {
      const restarted = new CloudGroupOutbox('acct_me', defaultCloudGroupOutboxPersistence('acct_me'));
      const [restored] = await restarted.restore();
      assert.equal(restored?.payloadVersion, 2);
      assert.equal(restored?.envelope, 'manual-retry-envelope');
      assert.equal(restored?.attachments, undefined);
      assert.equal(restored?.pendingAttachments?.[0]?.path, '/tmp/kordi/retry.png');
      assert.deepEqual(restored?.pendingRecipientIds, ['acct_b']);
      assert.deepEqual(restored?.deliveredRecipientIds, ['acct_a']);
      assert.equal(restored?.exhaustedRecipientIds, undefined);
      assert.deepEqual(restored?.attemptsByRecipientId, { acct_b: 0, acct_a: 0 });
    });
  }
});

test('restart reconciles a newer fallback delivery state before promoting it to IndexedDB', async () => {
  const events: string[] = [];
  const storage = new MemoryStorage(events);
  const indexedDb = new ControllableIndexedDb({
    version: 1,
    entries: [entry()],
    completedCanonicalMessageIds: [],
  }, events);

  await withBrowserPersistenceGlobals(indexedDb.factory, storage, async () => {
    indexedDb.failWrites = true;
    const first = new CloudGroupOutbox('acct_me', defaultCloudGroupOutboxPersistence('acct_me'));
    await first.restore();
    await first.deliver('msg:canonical:one', async () => {}, { nowMs: 100, force: true });
    assert.equal(first.entries()[0]?.awaitingCanonicalAck, true);
    assert.equal(storage.length, 1, 'failed IDB write must retain the fallback snapshot');

    indexedDb.failWrites = false;
    const restarted = new CloudGroupOutbox('acct_me', defaultCloudGroupOutboxPersistence('acct_me'));
    const restored = await restarted.restore();
    assert.equal(restored[0]?.awaitingCanonicalAck, true);
    assert.deepEqual(restored[0]?.pendingRecipientIds, []);
    assert.deepEqual(restored[0]?.deliveredRecipientIds, ['acct_a', 'acct_b']);

    let sends = 0;
    await restarted.deliverDue(async () => { sends += 1; }, 200);
    assert.equal(sends, 0, 'recovery must not resend recipients already recorded as delivered');
    assert.equal(indexedDb.value?.entries[0]?.awaitingCanonicalAck, true);
    assert.equal(storage.length, 0, 'fallback is removed after the recovered snapshot reaches IDB');
    const idbWriteCompletedAt = events.indexOf('idb-put-complete');
    const fallbackRemovedAt = events.indexOf('storage-remove');
    assert.ok(
      idbWriteCompletedAt >= 0 && fallbackRemovedAt > idbWriteCompletedAt,
      'fallback cleanup must happen only after the IDB transaction completes',
    );
  });
});

test('completion tombstones filter stale fallback entries before the persisted list is capped', async () => {
  const events: string[] = [];
  const storage = new MemoryStorage(events);
  const completedCanonicalMessageId = entry().canonicalMessageId;
  const indexedDb = new ControllableIndexedDb({
    version: 1,
    entries: [],
    completedCanonicalMessageIds: [completedCanonicalMessageId],
  }, events);
  storage.setItem('kordi.cloud.groupOutbox.v1:acct_me', JSON.stringify({
    version: 1,
    entries: [entry()],
    completedCanonicalMessageIds: Array.from(
      { length: 1_000 },
      (_, index) => `msg:canonical:fallback-completed:${index}`,
    ),
  }));

  await withBrowserPersistenceGlobals(indexedDb.factory, storage, async () => {
    const restarted = new CloudGroupOutbox('acct_me', defaultCloudGroupOutboxPersistence('acct_me'));
    const restored = await restarted.restore();
    assert.deepEqual(restored, [], 'the stale entry must stay suppressed even if its tombstone is evicted');

    let sends = 0;
    await restarted.deliverDue(async () => { sends += 1; }, 200);
    assert.equal(sends, 0);
    assert.deepEqual(indexedDb.value?.entries, []);
    assert.equal(indexedDb.value?.completedCanonicalMessageIds.length, 1_000);
  });
});

test('promotion retains a suppressing tombstone when fallback cleanup fails before restart', async () => {
  const events: string[] = [];
  const storage = new MemoryStorage(events);
  storage.failRemovals = true;
  const completedCanonicalMessageId = entry().canonicalMessageId;
  const indexedDb = new ControllableIndexedDb({
    version: 1,
    entries: [],
    completedCanonicalMessageIds: [completedCanonicalMessageId],
  }, events);
  storage.setItem('kordi.cloud.groupOutbox.v1:acct_me', JSON.stringify({
    version: 1,
    entries: [entry()],
    completedCanonicalMessageIds: Array.from(
      { length: 1_000 },
      (_, index) => `msg:canonical:fallback-completed:${index}`,
    ),
  }));

  await withBrowserPersistenceGlobals(indexedDb.factory, storage, async () => {
    const promoted = new CloudGroupOutbox('acct_me', defaultCloudGroupOutboxPersistence('acct_me'));
    assert.deepEqual(await promoted.restore(), []);
    assert.equal(storage.length, 1, 'failed cleanup must leave the fallback available');
    assert.equal(
      indexedDb.value?.completedCanonicalMessageIds.includes(completedCanonicalMessageId),
      true,
      'the promoted state must retain the tombstone that suppresses the fallback entry',
    );

    const restarted = new CloudGroupOutbox('acct_me', defaultCloudGroupOutboxPersistence('acct_me'));
    assert.deepEqual(await restarted.restore(), []);
    let sends = 0;
    await restarted.deliverDue(async () => { sends += 1; }, 200);
    assert.equal(sends, 0, 'the retained fallback must not resurrect a completed delivery');
  });
});

test('enqueue rejects when neither browser persistence backend accepts the snapshot', async () => {
  await withBrowserPersistenceGlobals(undefined, undefined, async () => {
    const outbox = new CloudGroupOutbox('acct_me', defaultCloudGroupOutboxPersistence('acct_me'));
    await outbox.restore();

    await assert.rejects(
      outbox.enqueue(entry()),
      /unable to persist the cloud group outbox/i,
    );
    assert.deepEqual(outbox.entries(), [], 'a rejected enqueue must not leave a memory-only entry');
    await assert.rejects(
      outbox.enqueue(entry()),
      /unable to persist the cloud group outbox/i,
      'a retry must not bypass durability through the failed in-memory entry',
    );
  });
});

test('concurrent duplicate enqueue shares the first persistence failure', async () => {
  const persistence = new ControlledFirstSaveFailurePersistence();
  const outbox = new CloudGroupOutbox('acct_me', persistence);
  await outbox.restore();

  const firstEnqueue = outbox.enqueue(entry());
  const firstResult = assert.rejects(firstEnqueue, /forced first save failure/);
  await persistence.firstSaveStarted;
  const duplicateEnqueue = outbox.enqueue(entry());
  const duplicateResult = assert.rejects(duplicateEnqueue, /forced first save failure/);
  persistence.releaseFirstSave();

  await Promise.all([firstResult, duplicateResult]);
  assert.deepEqual(outbox.entries(), []);
  assert.equal(persistence.value, null);
});

test('concurrent duplicate enqueue stays pending until the shared durable save succeeds', async () => {
  const persistence = new ControlledFirstSaveSuccessPersistence();
  const outbox = new CloudGroupOutbox('acct_me', persistence);
  await outbox.restore();

  const firstEnqueue = outbox.enqueue(entry());
  await persistence.firstSaveStarted;
  let duplicateSettled = false;
  const duplicateEnqueue = outbox.enqueue(entry()).then((result) => {
    duplicateSettled = true;
    return result;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(duplicateSettled, false, 'duplicate must not fulfill before the durable save');
  persistence.releaseFirstSave();

  const [firstResult, duplicateResult] = await Promise.all([firstEnqueue, duplicateEnqueue]);
  assert.deepEqual(duplicateResult, firstResult);
  assert.equal(persistence.saveCount, 1, 'concurrent duplicates must share one mutation transaction');

  assert.deepEqual(await outbox.enqueue(entry()), firstResult, 'an already committed duplicate remains idempotent');
  assert.equal(persistence.saveCount, 1, 'an already committed duplicate must not rewrite persistence');
});

test('delivery rejects without sending when its pending enqueue persistence fails', async () => {
  const persistence = new ControlledFirstSaveFailurePersistence();
  const outbox = new CloudGroupOutbox('acct_me', persistence);
  await outbox.restore();

  const enqueueResult = assert.rejects(outbox.enqueue(entry()), /forced first save failure/);
  await persistence.firstSaveStarted;
  let sends = 0;
  const deliveryResult = assert.rejects(
    outbox.deliverDue(async () => { sends += 1; }, 0),
    /forced first save failure/,
  );
  persistence.releaseFirstSave();

  await Promise.all([enqueueResult, deliveryResult]);
  assert.equal(sends, 0, 'delivery must not escape before its outbox entry is durable');
  assert.deepEqual(outbox.entries(), []);
});

test('concurrent deliveries wait for one durable enqueue and share one delivery flight', async () => {
  const persistence = new ControlledFirstSaveSuccessPersistence();
  const outbox = new CloudGroupOutbox('acct_me', persistence);
  await outbox.restore();

  const enqueueResult = outbox.enqueue(entry());
  await persistence.firstSaveStarted;
  const sentRecipientIds: string[] = [];
  const send = async ({ recipientId }: { recipientId: string }) => { sentRecipientIds.push(recipientId); };
  const firstDelivery = outbox.deliver('msg:canonical:one', send, { nowMs: 100, force: true });
  const secondDelivery = outbox.deliver('msg:canonical:one', send, { nowMs: 100, force: true });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(sentRecipientIds, [], 'recipient sends must wait for the durable enqueue');
  persistence.releaseFirstSave();

  await enqueueResult;
  const [firstOutcome, secondOutcome] = await Promise.all([firstDelivery, secondDelivery]);
  assert.deepEqual(secondOutcome, firstOutcome);
  assert.deepEqual(sentRecipientIds.sort(), ['acct_a', 'acct_b']);
});

test('a queued successful enqueue cannot persist an entry whose earlier save rejected', async () => {
  const persistence = new ControlledFirstSaveFailurePersistence();
  const outbox = new CloudGroupOutbox('acct_me', persistence);
  await outbox.restore();
  const rejectedEntry = { ...entry(), canonicalMessageId: 'msg:canonical:rejected' };
  const retainedEntry = { ...entry(), canonicalMessageId: 'msg:canonical:retained' };

  const rejectedEnqueue = outbox.enqueue(rejectedEntry);
  await persistence.firstSaveStarted;
  const retainedEnqueue = outbox.enqueue(retainedEntry);
  await Promise.resolve();
  assert.deepEqual(
    outbox.entries().map((candidate) => candidate.canonicalMessageId),
    ['msg:canonical:rejected', 'msg:canonical:retained'],
  );
  persistence.releaseFirstSave();

  await assert.rejects(rejectedEnqueue, /forced first save failure/);
  await retainedEnqueue;
  assert.deepEqual(
    outbox.entries().map((candidate) => candidate.canonicalMessageId),
    ['msg:canonical:retained'],
  );

  const restarted = new CloudGroupOutbox('acct_me', persistence);
  const restored = await restarted.restore();
  assert.deepEqual(
    restored.map((candidate) => candidate.canonicalMessageId),
    ['msg:canonical:retained'],
    'durable state must match the post-rollback in-memory state',
  );
});

test('a successful enqueue cannot persist a concurrent enqueue whose later save rejects', async () => {
  const persistence = new ControlledFirstSuccessSecondFailurePersistence();
  const outbox = new CloudGroupOutbox('acct_me', persistence);
  await outbox.restore();
  const retainedEntry = { ...entry(), canonicalMessageId: 'msg:canonical:retained' };
  const rejectedEntry = { ...entry(), canonicalMessageId: 'msg:canonical:rejected' };

  const retainedEnqueue = outbox.enqueue(retainedEntry);
  const rejectedEnqueue = outbox.enqueue(rejectedEntry);
  const rejectedResult = assert.rejects(rejectedEnqueue, /forced second save failure/);
  await persistence.firstSaveStarted;
  persistence.releaseFirstSave();

  await retainedEnqueue;
  await rejectedResult;
  assert.deepEqual(
    outbox.entries().map((candidate) => candidate.canonicalMessageId),
    ['msg:canonical:retained'],
  );

  const restarted = new CloudGroupOutbox('acct_me', persistence);
  assert.deepEqual(
    (await restarted.restore()).map((candidate) => candidate.canonicalMessageId),
    ['msg:canonical:retained'],
    'the earlier successful save must exclude the later rejected mutation',
  );
});

test('one fulfilled and one rejected target leaves only the failed recipient pending', async () => {
  const persistence = new MemoryPersistence();
  const outbox = new CloudGroupOutbox('acct_me', persistence);
  await outbox.restore();
  await outbox.enqueue(entry());
  const sentClientIds: string[] = [];

  const outcome = await outbox.deliver('msg:canonical:one', async ({ recipientId, clientMessageId }) => {
    sentClientIds.push(clientMessageId);
    if (recipientId === 'acct_b') throw new Error('offline');
  }, { nowMs: 100, force: true });

  assert.deepEqual(sentClientIds.sort(), [
    'msg:canonical:one:acct_a',
    'msg:canonical:one:acct_b',
  ]);
  assert.deepEqual(outcome?.deliveredRecipientIds, ['acct_a']);
  assert.deepEqual(outcome?.pendingRecipientIds, ['acct_b']);
  assert.equal(outcome?.nextAttemptAtMs, 1_100);
});

test('restart restores a pending outbox entry', async () => {
  const persistence = new MemoryPersistence();
  const first = new CloudGroupOutbox('acct_me', persistence);
  await first.restore();
  await first.enqueue(entry());
  await first.deliver('msg:canonical:one', async ({ recipientId }) => {
    if (recipientId === 'acct_b') throw new Error('offline');
  }, { nowMs: 100, force: true });

  const restarted = new CloudGroupOutbox('acct_me', persistence);
  await restarted.restore();
  assert.deepEqual(restarted.entries()[0]?.pendingRecipientIds, ['acct_b']);
  assert.deepEqual(restarted.entries()[0]?.deliveredRecipientIds, ['acct_a']);
});

test('successful recipient delivery stays durable until canonical acknowledgement survives restart', async () => {
  const persistence = new MemoryPersistence();
  const first = new CloudGroupOutbox('acct_me', persistence);
  await first.restore();
  await first.enqueue(entry());
  const outcome = await first.deliver('msg:canonical:one', async () => {}, { nowMs: 100, force: true });

  assert.equal(outcome?.awaitingCanonicalAck, true);
  assert.equal(first.entries()[0]?.awaitingCanonicalAck, true);
  assert.deepEqual(first.entries()[0]?.pendingRecipientIds, []);
  assert.deepEqual(persistence.value?.completedCanonicalMessageIds, []);

  let acknowledgementReached = false;
  const writeCanonical = async () => { throw new Error('forced canonical failure'); };
  await assert.rejects(async () => {
    await writeCanonical();
    // This mirrors the native-write-before-ack ordering guarded by the source test.
    acknowledgementReached = true;
    await first.acknowledgeCanonicalDelivery('msg:canonical:one');
  }, /forced canonical failure/);
  assert.equal(acknowledgementReached, false);
  const restarted = new CloudGroupOutbox('acct_me', persistence);
  const restored = await restarted.restore();
  assert.equal(restored[0]?.awaitingCanonicalAck, true);

  let replaySends = 0;
  const replayed = await restarted.deliverDue(async () => { replaySends += 1; }, 200);
  assert.equal(replaySends, 0, 'canonical replay must not resend recipients');
  assert.equal(replayed[0]?.awaitingCanonicalAck, true);

  assert.equal(await restarted.acknowledgeCanonicalDelivery('msg:canonical:one'), true);
  assert.deepEqual(restarted.entries(), []);
  assert.deepEqual(persistence.value?.completedCanonicalMessageIds, ['msg:canonical:one']);
  assert.equal(await restarted.acknowledgeCanonicalDelivery('msg:canonical:one'), true, 'ack is idempotent');
  assert.equal(await restarted.enqueue(entry()), null, 'completed canonical ids still block duplicate sends');
});

test('failed canonical acknowledgement rolls back so retry persists completion across restart', async () => {
  const persistence = new MemoryPersistence();
  const initial = new CloudGroupOutbox('acct_me', persistence);
  await initial.restore();
  await initial.enqueue(entry());
  await initial.deliver('msg:canonical:one', async () => {}, { nowMs: 100, force: true });
  const previousCompletedCanonicalMessageIds = Array.from(
    { length: 1_000 },
    (_, index) => `msg:canonical:previously-completed:${index}`,
  );
  persistence.value = {
    ...persistence.value!,
    completedCanonicalMessageIds: previousCompletedCanonicalMessageIds,
  };
  const outbox = new CloudGroupOutbox('acct_me', persistence);
  await outbox.restore();
  persistence.failNextSave();

  await assert.rejects(
    outbox.acknowledgeCanonicalDelivery('msg:canonical:one'),
    /forced persistence failure/,
  );
  assert.equal(outbox.entries()[0]?.awaitingCanonicalAck, true);
  assert.equal(
    await outbox.enqueue({
      ...entry(),
      canonicalMessageId: previousCompletedCanonicalMessageIds[0]!,
    }),
    null,
    'rollback must restore a completion tombstone evicted by the failed acknowledgement',
  );
  assert.equal(await outbox.acknowledgeCanonicalDelivery('msg:canonical:one'), true);

  const restarted = new CloudGroupOutbox('acct_me', persistence);
  assert.deepEqual(await restarted.restore(), []);
  assert.equal(await restarted.enqueue(entry()), null, 'retry must durably retain the completion tombstone');
});

test('concurrent failed acknowledgements restore exact capped state before independent retries', async () => {
  const firstCanonicalMessageId = 'msg:canonical:awaiting:first';
  const secondCanonicalMessageId = 'msg:canonical:awaiting:second';
  const completedCanonicalMessageIds = Array.from(
    { length: 1_000 },
    (_, index) => `msg:canonical:completed:${index}`,
  );
  const persistence = new MemoryPersistence();
  persistence.value = {
    version: 1,
    entries: [awaitingEntry(firstCanonicalMessageId), awaitingEntry(secondCanonicalMessageId)],
    completedCanonicalMessageIds,
  };
  const outbox = new CloudGroupOutbox('acct_me', persistence);
  await outbox.restore();
  persistence.failNextSave();
  persistence.failNextSave();

  const acknowledgements = await Promise.allSettled([
    outbox.acknowledgeCanonicalDelivery(firstCanonicalMessageId),
    outbox.acknowledgeCanonicalDelivery(secondCanonicalMessageId),
  ]);
  assert.deepEqual(acknowledgements.map((result) => result.status), ['rejected', 'rejected']);
  assert.deepEqual(
    outbox.entries().map((candidate) => candidate.canonicalMessageId),
    [firstCanonicalMessageId, secondCanonicalMessageId],
    'both failed mutations must restore the exact prior entries',
  );
  assert.equal(
    await outbox.enqueue({
      ...entry(),
      canonicalMessageId: completedCanonicalMessageIds[0]!,
    }),
    null,
    'concurrent rollbacks must preserve the oldest capped tombstone',
  );

  assert.deepEqual(await Promise.all([
    outbox.acknowledgeCanonicalDelivery(firstCanonicalMessageId),
    outbox.acknowledgeCanonicalDelivery(secondCanonicalMessageId),
  ]), [true, true]);
  const restarted = new CloudGroupOutbox('acct_me', persistence);
  assert.deepEqual(await restarted.restore(), []);
  assert.equal(await restarted.enqueue(awaitingEntry(firstCanonicalMessageId)), null);
  assert.equal(await restarted.enqueue(awaitingEntry(secondCanonicalMessageId)), null);
});

test('canonical acknowledgement refuses pending, partial, and exhausted deliveries', async () => {
  const pending = new CloudGroupOutbox('acct_me', new MemoryPersistence());
  await pending.restore();
  await pending.enqueue(entry());
  assert.equal(await pending.acknowledgeCanonicalDelivery('msg:canonical:one'), false);

  const partial = new CloudGroupOutbox('acct_me', new MemoryPersistence());
  await partial.restore();
  await partial.enqueue(entry());
  await partial.deliver('msg:canonical:one', async ({ recipientId }) => {
    if (recipientId === 'acct_b') throw new Error('offline');
  }, { nowMs: 100, force: true });
  assert.equal(await partial.acknowledgeCanonicalDelivery('msg:canonical:one'), false);

  const exhausted = new CloudGroupOutbox('acct_me', new MemoryPersistence());
  await exhausted.restore();
  await exhausted.enqueue(entry());
  let nowMs = 100;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const exhaustedOutcome = await exhausted.deliver('msg:canonical:one', async () => {
      throw new Error('offline');
    }, { nowMs, force: true });
    nowMs = exhaustedOutcome?.nextAttemptAtMs ?? nowMs;
  }
  assert.equal(await exhausted.acknowledgeCanonicalDelivery('msg:canonical:one'), false);
  assert.equal(exhausted.entries().length, 1);
});

test('legacy persisted entries normalize without an awaiting canonical acknowledgement phase', async () => {
  const persistence = new MemoryPersistence();
  persistence.value = {
    version: 1,
    entries: [entry()],
    completedCanonicalMessageIds: [],
  };
  const outbox = new CloudGroupOutbox('acct_me', persistence);

  const restored = await outbox.restore();

  assert.equal(restored[0]?.awaitingCanonicalAck, false);
});

test('restart retains the exact canonical target when it is older than 200 newer rows', async () => {
  const persistence = new MemoryPersistence();
  const first = new CloudGroupOutbox('acct_me', persistence);
  await first.restore();
  await first.enqueue(entry());
  await first.deliver('msg:canonical:one', async ({ recipientId }) => {
    if (recipientId === 'acct_b') throw new Error('offline');
  }, { nowMs: 100, force: true });

  const newerCanonicalMessageIds = Array.from(
    { length: 201 },
    (_, index) => `msg:canonical:newer:${index + 1}`,
  );
  const latestPageIds = newerCanonicalMessageIds.slice(-200);
  assert.equal(latestPageIds.includes('msg:canonical:one'), false);

  const restarted = new CloudGroupOutbox('acct_me', persistence);
  await restarted.restore();
  const [outcome] = await restarted.deliverDue(async () => {}, 1_100);
  assert.equal(outcome?.canonicalMessageId, 'msg:canonical:one');
  assert.deepEqual(cloudGroupOutboxDeliveryStatus(outcome!), {
    status: 'delivered',
    deliveryState: 'delivered',
    deliveredRecipientIds: ['acct_a', 'acct_b'],
    pendingRecipientIds: [],
    exhaustedRecipientIds: [],
  });
  assert.equal(outcome?.awaitingCanonicalAck, true);
  assert.equal(await restarted.acknowledgeCanonicalDelivery('msg:canonical:one'), true);
});

test('retry sends only the failed recipient', async () => {
  const persistence = new MemoryPersistence();
  const outbox = new CloudGroupOutbox('acct_me', persistence);
  await outbox.restore();
  await outbox.enqueue(entry());
  await outbox.deliver('msg:canonical:one', async ({ recipientId }) => {
    if (recipientId === 'acct_b') throw new Error('offline');
  }, { nowMs: 100, force: true });
  const retried: string[] = [];

  await outbox.deliverDue(async ({ recipientId }) => {
    retried.push(recipientId);
  }, 1_100);

  assert.deepEqual(retried, ['acct_b']);
  assert.equal(outbox.entries()[0]?.awaitingCanonicalAck, true);
  assert.equal(await outbox.acknowledgeCanonicalDelivery('msg:canonical:one'), true);
  assert.deepEqual(outbox.entries(), []);
});

test('a second enqueue with a completed canonical id cannot duplicate delivery', async () => {
  const persistence = new MemoryPersistence();
  const outbox = new CloudGroupOutbox('acct_me', persistence);
  await outbox.restore();
  await outbox.enqueue(entry());
  let sends = 0;
  await outbox.deliver('msg:canonical:one', async () => { sends += 1; }, { nowMs: 100, force: true });
  assert.equal(await outbox.acknowledgeCanonicalDelivery('msg:canonical:one'), true);

  const duplicate = await outbox.enqueue(entry());
  await outbox.deliver('msg:canonical:one', async () => { sends += 1; }, { nowMs: 200, force: true });

  assert.equal(duplicate, null);
  assert.equal(sends, 2);
});

test('six rejected attempts become a durable exhausted failure instead of retrying forever', async () => {
  const persistence = new MemoryPersistence();
  const outbox = new CloudGroupOutbox('acct_me', persistence);
  await outbox.restore();
  await outbox.enqueue(entry());
  let nowMs = 100;
  let outcome = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    outcome = await outbox.deliver('msg:canonical:one', async () => {
      throw new Error('offline');
    }, { nowMs, force: true });
    nowMs = outcome?.nextAttemptAtMs ?? nowMs;
  }

  assert.deepEqual(outcome?.pendingRecipientIds, []);
  assert.deepEqual(outcome?.exhaustedRecipientIds, ['acct_a', 'acct_b']);
  assert.deepEqual(outbox.entries()[0]?.exhaustedRecipientIds, ['acct_a', 'acct_b']);
  assert.deepEqual((await outbox.deliverDue(async () => { throw new Error('must not retry'); }, nowMs + 30_000)), []);
});

test('manual retry durably requeues exhausted recipients with the refreshed payload', async () => {
  const persistence = new MemoryPersistence();
  const outbox = new CloudGroupOutbox('acct_me', persistence);
  await outbox.restore();
  await outbox.enqueue(entry());
  let nowMs = 100;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const outcome = await outbox.deliver('msg:canonical:one', async () => {
      throw new Error('offline');
    }, { nowMs, force: true });
    nowMs = outcome?.nextAttemptAtMs ?? nowMs;
  }

  const requeued = await outbox.requeueFailed({
    ...entry(),
    envelope: 'refreshed-envelope',
    attachments: [{
      attachmentId: 'att_retry',
      name: 'retry.png',
      kind: 'image',
      mimeType: 'image/png',
      sizeBytes: 42,
    }],
  });

  assert.equal(requeued?.envelope, 'refreshed-envelope');
  assert.deepEqual(requeued?.pendingRecipientIds, ['acct_a', 'acct_b']);
  assert.deepEqual(requeued?.deliveredRecipientIds, []);
  assert.deepEqual(requeued?.exhaustedRecipientIds, undefined);
  assert.deepEqual(requeued?.attemptsByRecipientId, { acct_a: 0, acct_b: 0 });
  assert.equal(requeued?.payloadVersion, 1);
  assert.equal(requeued?.deliveryGeneration, 1);
  assert.equal(persistence.value?.entries[0]?.envelope, 'refreshed-envelope');

  const retried: string[] = [];
  await outbox.deliver('msg:canonical:one', async ({ recipientId, entry: retriedEntry }) => {
    retried.push(recipientId);
    assert.equal(retriedEntry.attachments?.[0]?.attachmentId, 'att_retry');
  }, { nowMs: nowMs + 1, force: true });
  assert.deepEqual(retried.sort(), ['acct_a', 'acct_b']);
});

function canonicalState(): CanonicalSessionState {
  return {
    storagePath: '/tmp/canonical',
    profile: {
      id: 'profile',
      humanIdentityId: 'human:me',
      storageRoot: '/tmp/canonical',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [],
    sessions: [],
    participants: [],
    messages: [{
      id: 'msg:canonical:one',
      sessionId: 'session:group:one',
      senderIdentityId: 'human:me',
      senderRole: 'user',
      messageKind: 'text',
      contentText: 'hello',
      content: { deliveryState: 'sending' },
      status: 'sending',
      sequenceNum: 1,
      createdAtMs: 1,
      updatedAtMs: 1,
    }],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };
}

test('canonical delivery state reports partial and exhausted recipients honestly', () => {
  const state = patchCanonicalCloudGroupOutboxDelivery(canonicalState(), {
    ...entry(),
    pendingRecipientIds: [],
    deliveredRecipientIds: ['acct_a'],
    exhaustedRecipientIds: ['acct_b'],
    attemptsByRecipientId: { acct_b: 6 },
  });
  const message = state?.messages[0];
  const content = message?.content as Record<string, unknown>;

  assert.equal(message?.status, 'delivered');
  assert.equal(content.deliveryState, 'partial');
  assert.deepEqual(content.deliveredRecipientIds, ['acct_a']);
  assert.deepEqual(content.pendingRecipientIds, []);
  assert.deepEqual(content.exhaustedRecipientIds, ['acct_b']);
});

test('canonical delivery state is failed only when every recipient is exhausted', () => {
  const state = patchCanonicalCloudGroupOutboxDelivery(canonicalState(), {
    ...entry(),
    pendingRecipientIds: [],
    exhaustedRecipientIds: ['acct_a', 'acct_b'],
    attemptsByRecipientId: { acct_a: 6, acct_b: 6 },
  });
  assert.equal(state?.messages[0]?.status, 'failed');
  assert.equal((state?.messages[0]?.content as Record<string, unknown>).deliveryState, 'failed');
});
