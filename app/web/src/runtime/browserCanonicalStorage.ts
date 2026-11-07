import { browserCanonicalScope } from '@web/runtime/browserCanonicalScope';
export { browserCanonicalScope } from '@web/runtime/browserCanonicalScope';
import type { CanonicalSessionState } from '@/kordi-app/types';
import type { ChatSyncLocalState } from '@/lib/desktopChatSync';
import { browserCanonicalCloudMessageId, emptyBrowserCanonicalState } from '@web/runtime/browserCanonicalProjection';
import { applyBrowserCanonicalCommand } from '@web/runtime/browserCanonicalCommands';
import { browserCanonicalCommandChanged } from '@web/runtime/browserCanonicalChanges';

const DATABASE_NAME = 'kordi-browser-canonical-v1';
const STORE_NAME = 'projections';
export const BROWSER_CANONICAL_CHANGED_EVENT = 'kordi-browser-canonical-changed';
let database: Promise<IDBDatabase> | null = null;
const activeScopes = new Set<string>();
let storageGeneration = 0;


function openDatabase(): Promise<IDBDatabase> {
  if (!database) database = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('Browser storage is unavailable. Allow site storage and reload Kordi.'));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onerror = () => reject(request.error ?? new Error('Could not open browser chat storage.'));
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); database = null; };
      resolve(request.result);
    };
  }).catch(error => { database = null; throw error; });
  return database;
}

export async function updateBrowserStoredRecord<T, R>(key: string, initial: () => T,
  update: (record: T) => R, readonly = false, shouldWrite: () => boolean = () => true): Promise<R> {
  const generation = storageGeneration;
  activeScopes.add(key);
  const db = await openDatabase();
  if (generation !== storageGeneration) throw new Error('The signed-in account changed.');
  return new Promise<R>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, readonly ? 'readonly' : 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(key);
    let result: R;
    let failure: unknown;
    request.onsuccess = () => {
      try {
        const record = (request.result as T | undefined) ?? initial();
        result = update(record);
        if (!readonly && shouldWrite()) store.put(record, key);
      } catch (error) { failure = error; transaction.abort(); }
    };
    transaction.onabort = () => reject(failure instanceof Error ? failure
      : new Error(transaction.error?.message ?? 'Chat storage was interrupted. Try again.'));
    transaction.onerror = () => reject(new Error(transaction.error?.message ?? 'Could not save browser chat data.'));
    transaction.oncomplete = () => resolve(result);
  });
}

/** A read/write IndexedDB transaction serializes concurrent tabs and prevents lost updates. */
export async function runBrowserCanonicalCommand(accountId: string, organizationId: string | undefined,
  command: string, args: Record<string, unknown> = {}) {
  const scope = browserCanonicalScope(accountId, organizationId);
  if (args.expectedBrowserScope !== undefined && args.expectedBrowserScope !== scope) {
    throw new Error('The organization changed while replaying this conversation.');
  }
  const readonly = ['desktop_canonical_session_state', 'desktop_canonical_session_catalog',
    'desktop_canonical_session_messages', 'desktop_canonical_existing_message_sources'].includes(command);
  let changed = false;
  const result = await updateBrowserStoredRecord(scope, () => emptyBrowserCanonicalState(accountId), state => {
    const applied = browserCanonicalCommandChanged(state, command, () => applyBrowserCanonicalCommand(state, command, args));
    changed = applied.changed;
    return applied.result;
  }, readonly, () => changed);
  // A replay that changed nothing must not refresh the store: the refresh
  // re-runs replay, which would otherwise write and refresh again forever.
  if (!readonly && changed && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(BROWSER_CANONICAL_CHANGED_EVENT));
  return result;
}

export async function clearBrowserCanonicalStorage(accountId?: string) {
  storageGeneration += 1;
  const scopes = [...activeScopes];
  activeScopes.clear();
  if (!scopes.length && !accountId) return;
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    if (accountId) {
      const cursor = store.openKeyCursor();
      cursor.onsuccess = () => {
        if (!cursor.result) return;
        const key = cursor.result.key;
        if (typeof key === 'string') {
          try {
            const parsed = JSON.parse(key.startsWith('sync:') ? key.slice(5) : key) as unknown;
            if (Array.isArray(parsed) && parsed[0] === accountId) store.delete(key);
          } catch { /* Other versions of the cache own their own records. */ }
        }
        cursor.result.continue();
      };
    } else for (const scope of scopes) store.delete(scope);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new Error(transaction.error?.message ?? 'Could not clear browser chat data.'));
  });
}

/** Compare both durable projections inside one transaction, so concurrent sync
 * cannot make newly arrived server messages appear missing. */
export async function pruneBrowserCanonicalCloudMessages(accountId: string, organizationId?: string): Promise<string[]> {
  const scope = browserCanonicalScope(accountId, organizationId);
  const generation = storageGeneration;
  const db = await openDatabase();
  if (generation !== storageGeneration) throw new Error('The signed-in account changed.');
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const canonicalRequest = store.get(scope);
    const syncRequest = store.get(`sync:${scope}`);
    const removed: string[] = [];
    syncRequest.onsuccess = () => {
      const canonical = canonicalRequest.result as CanonicalSessionState | undefined;
      const sync = syncRequest.result as ChatSyncLocalState | undefined;
      if (!canonical || !sync) return;
      const live = new Set(sync.messages.map(row => row.id));
      canonical.messages = canonical.messages.filter(row => {
        const cloudId = browserCanonicalCloudMessageId(row);
        if (!cloudId || live.has(cloudId)) return true;
        removed.push(row.id);
        return false;
      });
      store.put(canonical, scope);
    };
    transaction.oncomplete = () => resolve(removed);
    transaction.onabort = transaction.onerror = () => reject(new Error('Could not reconcile browser chat history.'));
  });
}
