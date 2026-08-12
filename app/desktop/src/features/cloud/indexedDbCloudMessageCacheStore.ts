import type { CloudMessageCacheStore } from './cloudMessageCache';

export const CLOUD_MESSAGES_INDEXED_DB_NAME = 'kordi-cloud-message-cache';
const PREVIOUS_CLOUD_MESSAGES_INDEXED_DB_NAME = 'kordi-cloud-message-cache-v2';
const CLOUD_MESSAGES_INDEXED_DB_STORE = 'messagesByAccount';

function readEntries(database: IDBDatabase) {
  return new Promise<Array<[IDBValidKey, unknown]>>((resolve, reject) => {
    const values: Array<[IDBValidKey, unknown]> = [];
    const transaction = database.transaction(CLOUD_MESSAGES_INDEXED_DB_STORE, 'readonly');
    const request = transaction.objectStore(CLOUD_MESSAGES_INDEXED_DB_STORE).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      values.push([cursor.key, cursor.value]);
      cursor.continue();
    };
    request.onerror = () => reject(request.error ?? new Error('Unable to read previous Cloud message cache.'));
    transaction.oncomplete = () => resolve(values);
    transaction.onabort = () => reject(transaction.error ?? new Error('Previous Cloud message cache migration aborted.'));
  });
}

export class IndexedDbCloudMessageCacheStore implements CloudMessageCacheStore {
  private database: Promise<IDBDatabase> | null = null;

  constructor(private readonly factory: IDBFactory) {}

  private open() {
    if (this.database) return this.database;
    this.database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.factory.open(CLOUD_MESSAGES_INDEXED_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(CLOUD_MESSAGES_INDEXED_DB_STORE)) {
          database.createObjectStore(CLOUD_MESSAGES_INDEXED_DB_STORE);
        }
      };
      request.onsuccess = () => {
        void this.migratePreviousDatabase(request.result).then(
          () => resolve(request.result),
          reject,
        );
      };
      request.onerror = () => reject(request.error ?? new Error('Unable to open Cloud message cache.'));
    });
    return this.database;
  }

  private async migratePreviousDatabase(current: IDBDatabase): Promise<void> {
    const previous = await new Promise<{ database: IDBDatabase; created: boolean }>((resolve, reject) => {
      let created = false;
      const request = this.factory.open(PREVIOUS_CLOUD_MESSAGES_INDEXED_DB_NAME, 1);
      request.onupgradeneeded = () => {
        created = true;
        if (!request.result.objectStoreNames.contains(CLOUD_MESSAGES_INDEXED_DB_STORE)) {
          request.result.createObjectStore(CLOUD_MESSAGES_INDEXED_DB_STORE);
        }
      };
      request.onsuccess = () => resolve({ database: request.result, created });
      request.onerror = () => reject(request.error ?? new Error('Unable to open previous Cloud message cache.'));
    });
    if (previous.created) {
      previous.database.close();
      this.factory.deleteDatabase(PREVIOUS_CLOUD_MESSAGES_INDEXED_DB_NAME);
      return;
    }

    const entries = await readEntries(previous.database);
    if (entries.length > 0) {
      await new Promise<void>((resolve, reject) => {
        const transaction = current.transaction(CLOUD_MESSAGES_INDEXED_DB_STORE, 'readwrite');
        const store = transaction.objectStore(CLOUD_MESSAGES_INDEXED_DB_STORE);
        for (const [key, value] of entries) {
          const existing = store.get(key);
          existing.onsuccess = () => {
            if (existing.result === undefined) store.put(value, key);
          };
          existing.onerror = () => reject(existing.error ?? new Error('Cloud message cache migration read failed.'));
        }
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error ?? new Error('Cloud message cache migration aborted.'));
        transaction.onerror = () => reject(transaction.error ?? new Error('Cloud message cache migration failed.'));
      });
    }
    previous.database.close();
    this.factory.deleteDatabase(PREVIOUS_CLOUD_MESSAGES_INDEXED_DB_NAME);
  }

  private async request<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>) {
    const database = await this.open();
    return new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(CLOUD_MESSAGES_INDEXED_DB_STORE, mode);
      const request = run(transaction.objectStore(CLOUD_MESSAGES_INDEXED_DB_STORE));
      let result: T;
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => reject(request.error ?? new Error('Cloud message cache request failed.'));
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(transaction.error ?? new Error('Cloud message cache transaction aborted.'));
      transaction.onerror = () => reject(transaction.error ?? new Error('Cloud message cache transaction failed.'));
    });
  }

  get(accountId: string) {
    return this.request('readonly', (store) => store.get(accountId));
  }

  async getMany(keys: readonly string[]) {
    if (keys.length === 0) return new Map<string, unknown>();
    const database = await this.open();
    return new Promise<ReadonlyMap<string, unknown>>((resolve, reject) => {
      const transaction = database.transaction(CLOUD_MESSAGES_INDEXED_DB_STORE, 'readonly');
      const store = transaction.objectStore(CLOUD_MESSAGES_INDEXED_DB_STORE);
      const values = new Map<string, unknown>();
      for (const key of keys) {
        const request = store.get(key);
        request.onsuccess = () => values.set(key, request.result);
        request.onerror = () => reject(request.error ?? new Error('Cloud message cache request failed.'));
      }
      transaction.oncomplete = () => resolve(values);
      transaction.onabort = () => reject(transaction.error ?? new Error('Cloud message cache transaction aborted.'));
      transaction.onerror = () => reject(transaction.error ?? new Error('Cloud message cache transaction failed.'));
    });
  }

  async set(accountId: string, value: unknown) {
    await this.request('readwrite', (store) => store.put(value, accountId));
  }

  async setMany(entries: ReadonlyMap<string, unknown>, removeKeys: readonly string[] = []) {
    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(CLOUD_MESSAGES_INDEXED_DB_STORE, 'readwrite');
      const store = transaction.objectStore(CLOUD_MESSAGES_INDEXED_DB_STORE);
      for (const key of removeKeys) store.delete(key);
      for (const [key, value] of entries) store.put(value, key);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error('Cloud message cache transaction aborted.'));
      transaction.onerror = () => reject(transaction.error ?? new Error('Cloud message cache transaction failed.'));
    });
  }

  async remove(accountId: string) {
    await this.request('readwrite', (store) => store.delete(accountId));
  }
}
