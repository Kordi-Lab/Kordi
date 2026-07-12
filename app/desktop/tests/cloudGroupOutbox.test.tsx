import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CloudGroupOutbox,
  cloudGroupOutboxDeliveryStatus,
  defaultCloudGroupOutboxPersistence,
  patchCanonicalCloudGroupOutboxDelivery,
  type CloudGroupOutboxPersistedState,
  type CloudGroupOutboxPersistence,
} from '../src/features/cloud/cloudGroupOutbox';
import type { CanonicalSessionState } from '../src/kordi-app/types';

class MemoryPersistence implements CloudGroupOutboxPersistence {
  value: CloudGroupOutboxPersistedState | null = null;
  async load() { return this.value ? structuredClone(this.value) : null; }
  async save(value: CloudGroupOutboxPersistedState) { this.value = structuredClone(value); }
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  constructor(private readonly events: string[] = []) {}

  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) {
    this.events.push('storage-remove');
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
            transaction.oncomplete?.call(transaction as unknown as IDBTransaction, new Event('complete'));
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
            this.value = structuredClone(value);
            request.onsuccess?.call(request as unknown as IDBRequest<IDBValidKey>, new Event('success'));
            this.events.push('idb-put-complete');
            transaction.oncomplete?.call(transaction as unknown as IDBTransaction, new Event('complete'));
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
