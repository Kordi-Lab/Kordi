import { type CloudGroupOutboxPersistedState, type CloudGroupOutboxPersistence } from '../src/features/cloud/cloudGroupOutbox';
import type { CanonicalSessionState } from '../src/kordi-app/types';

export class MemoryPersistence implements CloudGroupOutboxPersistence {
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

export class ControlledFirstSaveFailurePersistence extends MemoryPersistence {
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

export class ControlledFirstSaveSuccessPersistence extends MemoryPersistence {
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

export class ControlledFirstSuccessSecondFailurePersistence extends MemoryPersistence {
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

export class MemoryStorage implements Storage {
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

export type FakeRequest<T> = {
  result: T;
  error: DOMException | null;
  onsuccess: ((this: IDBRequest<T>, event: Event) => unknown) | null;
  onerror: ((this: IDBRequest<T>, event: Event) => unknown) | null;
};

export type FakeTransaction = {
  oncomplete: ((this: IDBTransaction, event: Event) => unknown) | null;
  onabort: ((this: IDBTransaction, event: Event) => unknown) | null;
  onerror: ((this: IDBTransaction, event: Event) => unknown) | null;
  objectStore(name: string): IDBObjectStore;
};

export class ControllableIndexedDb {
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

export async function withBrowserPersistenceGlobals<T>(
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

export function entry() {
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

export function awaitingEntry(canonicalMessageId: string) {
  return {
    ...entry(),
    canonicalMessageId,
    awaitingCanonicalAck: true,
    pendingRecipientIds: [],
    deliveredRecipientIds: ['acct_a', 'acct_b'],
  };
}

export function canonicalState(): CanonicalSessionState {
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
