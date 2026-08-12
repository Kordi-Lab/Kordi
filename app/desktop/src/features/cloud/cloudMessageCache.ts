import type { CloudMessage, CloudMessageAttachment } from './authClient';
import { safeCloudAttachmentPreviewUrl } from './cloudAttachments';

export const CLOUD_MESSAGES_INDEXED_DB_NAME = 'kordi-cloud-message-cache';
const PREVIOUS_CLOUD_MESSAGES_INDEXED_DB_NAME = 'kordi-cloud-message-cache-v2';
const CLOUD_MESSAGES_INDEXED_DB_STORE = 'messagesByAccount';
const CLOUD_MESSAGE_CACHE_VERSION = 3;
const CLOUD_MESSAGE_CACHE_SNAPSHOT_VERSION = 2;

export interface CloudMessageCache {
  load(accountId: string): Promise<Record<string, CloudMessage[]>>;
  save(accountId: string, value: Record<string, CloudMessage[]>): Promise<void>;
  remove(accountId: string): Promise<void>;
}

export interface CloudMessageCacheStore {
  get(accountId: string): Promise<unknown | undefined>;
  getMany(keys: readonly string[]): Promise<ReadonlyMap<string, unknown | undefined>>;
  set(accountId: string, value: unknown): Promise<void>;
  setMany(entries: ReadonlyMap<string, unknown>, removeKeys?: readonly string[]): Promise<void>;
  remove(accountId: string): Promise<void>;
}

type CloudMessageCacheManifest = {
  version: typeof CLOUD_MESSAGE_CACHE_VERSION;
  peerIds: string[];
};

type CloudMessageCachePeerRecord = {
  version: typeof CLOUD_MESSAGE_CACHE_VERSION;
  peerId: string;
  messages: CloudMessage[];
};

type PendingWrite = {
  changedPeers: Map<string, CloudMessage[]>;
  removedPeerIds: Set<string>;
  peerIds: string[];
  timer: ReturnType<typeof setTimeout>;
  ready: boolean;
  waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
};

type RecoverableWrite = Pick<PendingWrite, 'changedPeers' | 'removedPeerIds'>;

type ActiveWrite = {
  generation: number;
  settled: Promise<void>;
  settle: () => void;
};

function cleanText(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

export function cloudMessageAttachmentMetadataOnly(value: unknown): CloudMessageAttachment | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const attachmentId = cleanText(record.attachmentId);
  const name = cleanText(record.name);
  const kind = record.kind === 'image' ? 'image' : record.kind === 'file' ? 'file' : null;
  if (!attachmentId || !name || !kind) return null;
  const mimeType = cleanText(record.mimeType) || null;
  const sizeBytes = typeof record.sizeBytes === 'number' && Number.isFinite(record.sizeBytes) && record.sizeBytes >= 0
    ? record.sizeBytes
    : null;
  const previewAttachmentId = cleanText(record.previewAttachmentId);
  const previewUrl = safeCloudAttachmentPreviewUrl(
    typeof record.previewUrl === 'string' ? record.previewUrl : null,
  );
  return {
    attachmentId,
    name,
    kind,
    mimeType,
    sizeBytes,
    ...(previewAttachmentId ? { previewAttachmentId } : {}),
    ...(previewUrl ? { previewUrl } : {}),
  };
}

export function cloudMessageMetadataOnly(message: CloudMessage): CloudMessage {
  const attachments = (message.attachments ?? [])
    .map(cloudMessageAttachmentMetadataOnly)
    .filter((attachment): attachment is CloudMessageAttachment => Boolean(attachment));
  const { attachments: _attachments, ...metadata } = message;
  return attachments.length > 0 ? { ...metadata, attachments } : metadata;
}

function normalizedMessage(accountId: string, value: unknown): CloudMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const messageId = cleanText(record.messageId);
  const fromAccountId = cleanText(record.fromAccountId);
  const toAccountId = cleanText(record.toAccountId);
  const createdAt = cleanText(record.createdAt);
  if (!messageId || !fromAccountId || !toAccountId || !createdAt) return null;
  if (fromAccountId !== accountId && toAccountId !== accountId) return null;
  const attachments = Array.isArray(record.attachments)
    ? record.attachments.map(cloudMessageAttachmentMetadataOnly).filter((item): item is CloudMessageAttachment => Boolean(item))
    : [];
  const sessionId = cleanText(record.sessionId);
  const conversationId = cleanText(record.conversationId);
  const clientMessageId = cleanText(record.clientMessageId);
  const conversationSequence = Number.isSafeInteger(record.conversationSequence)
    && Number(record.conversationSequence) > 0 ? Number(record.conversationSequence) : null;
  const version = Number.isSafeInteger(record.version)
    && Number(record.version) > 0 ? Number(record.version) : null;
  return {
    messageId,
    fromAccountId,
    toAccountId,
    body: typeof record.body === 'string' ? record.body : '',
    createdAt,
    deliveredAt: typeof record.deliveredAt === 'string' ? record.deliveredAt : null,
    readAt: typeof record.readAt === 'string' ? record.readAt : null,
    direction: fromAccountId === accountId ? 'outgoing' : 'incoming',
    ...(sessionId ? { sessionId } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(clientMessageId ? { clientMessageId } : {}),
    ...(conversationSequence ? { conversationSequence } : {}),
    ...(version ? { version } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

export function normalizeCloudMessagesByPeer(
  accountId: string,
  value: unknown,
): Record<string, CloudMessage[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const source = (record.version === CLOUD_MESSAGE_CACHE_SNAPSHOT_VERSION || record.version === CLOUD_MESSAGE_CACHE_VERSION)
    && record.messagesByPeer
    && typeof record.messagesByPeer === 'object'
    && !Array.isArray(record.messagesByPeer)
    ? record.messagesByPeer as Record<string, unknown>
    : record;
  const result: Record<string, CloudMessage[]> = {};
  for (const [peerId, messages] of Object.entries(source)) {
    const normalizedPeerId = peerId.trim();
    if (!normalizedPeerId || !Array.isArray(messages)) continue;
    const normalized = messages
      .map((message) => normalizedMessage(accountId, message))
      .filter((message): message is CloudMessage => Boolean(message));
    if (normalized.length > 0) result[normalizedPeerId] = normalized;
  }
  return result;
}

function manifestCacheKey(accountId: string) {
  return `manifest:${accountId}`;
}

function peerCacheKey(accountId: string, peerId: string) {
  return `peer:${accountId}:${encodeURIComponent(peerId)}`;
}

function cacheManifest(value: unknown): CloudMessageCacheManifest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== CLOUD_MESSAGE_CACHE_VERSION || !Array.isArray(record.peerIds)) return null;
  return {
    version: CLOUD_MESSAGE_CACHE_VERSION,
    peerIds: [...new Set(record.peerIds.map(cleanText).filter(Boolean))].sort(),
  };
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
    const currentCount = await new Promise<number>((resolve, reject) => {
      const transaction = current.transaction(CLOUD_MESSAGES_INDEXED_DB_STORE, 'readonly');
      const request = transaction.objectStore(CLOUD_MESSAGES_INDEXED_DB_STORE).count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Unable to inspect Cloud message cache.'));
    });
    if (currentCount > 0) return;

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

    const entries = await new Promise<Array<[IDBValidKey, unknown]>>((resolve, reject) => {
      const values: Array<[IDBValidKey, unknown]> = [];
      const transaction = previous.database.transaction(CLOUD_MESSAGES_INDEXED_DB_STORE, 'readonly');
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
    if (entries.length > 0) {
      await new Promise<void>((resolve, reject) => {
        const transaction = current.transaction(CLOUD_MESSAGES_INDEXED_DB_STORE, 'readwrite');
        const store = transaction.objectStore(CLOUD_MESSAGES_INDEXED_DB_STORE);
        for (const [key, value] of entries) store.put(value, key);
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
    if (keys.length === 0) return new Map<string, unknown | undefined>();
    const database = await this.open();
    return new Promise<ReadonlyMap<string, unknown | undefined>>((resolve, reject) => {
      const transaction = database.transaction(CLOUD_MESSAGES_INDEXED_DB_STORE, 'readonly');
      const store = transaction.objectStore(CLOUD_MESSAGES_INDEXED_DB_STORE);
      const values = new Map<string, unknown | undefined>();
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

export class VersionedCloudMessageCache implements CloudMessageCache {
  private readonly pendingWrites = new Map<string, PendingWrite>();
  private readonly activeWrites = new Map<string, ActiveWrite>();
  private readonly activeRemovals = new Map<string, Promise<void>>();
  private readonly activeLoads = new Map<
    string,
    Set<Promise<Record<string, CloudMessage[]>>>
  >();
  private readonly accountGenerations = new Map<string, number>();
  private readonly failedWrites = new Map<string, RecoverableWrite>();
  private readonly latestValues = new Map<string, Record<string, CloudMessage[]>>();

  constructor(private readonly options: {
    store: CloudMessageCacheStore | null;
    debounceMs?: number;
  }) {}

  load(accountId: string): Promise<Record<string, CloudMessage[]>> {
    const normalizedAccountId = accountId.trim();
    if (!normalizedAccountId) return Promise.resolve({});
    const removal = this.activeRemovals.get(normalizedAccountId);
    if (removal) return removal.then(() => this.load(normalizedAccountId));
    const generation = this.accountGenerations.get(normalizedAccountId) ?? 0;
    const activeLoads = this.activeLoads.get(normalizedAccountId)
      ?? new Set<Promise<Record<string, CloudMessage[]>>>();
    let loading!: Promise<Record<string, CloudMessage[]>>;
    loading = this.loadAccount(normalizedAccountId, generation).finally(() => {
      activeLoads.delete(loading);
      if (activeLoads.size === 0) this.activeLoads.delete(normalizedAccountId);
    });
    activeLoads.add(loading);
    this.activeLoads.set(normalizedAccountId, activeLoads);
    return loading;
  }
  private async loadAccount(normalizedAccountId: string, generation: number) {
    const failedWriteAtStart = this.failedWrites.get(normalizedAccountId);
    const latestValueAtStart = this.latestValues.get(normalizedAccountId);
    if (this.options.store) {
      try {
        const manifest = cacheManifest(await this.options.store.get(manifestCacheKey(normalizedAccountId)));
        if (manifest) {
          const keys = manifest.peerIds.map((peerId) => peerCacheKey(normalizedAccountId, peerId));
          const records = await this.options.store.getMany(keys);
          const rawByPeer: Record<string, unknown> = {};
          for (const peerId of manifest.peerIds) {
            const value = records.get(peerCacheKey(normalizedAccountId, peerId));
            if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
            const peerRecord = value as Partial<CloudMessageCachePeerRecord>;
            if (peerRecord.version === CLOUD_MESSAGE_CACHE_VERSION && peerRecord.peerId === peerId) {
              rawByPeer[peerId] = peerRecord.messages;
            }
          }
          const messagesByPeer = normalizeCloudMessagesByPeer(normalizedAccountId, rawByPeer);
          return this.establishLoadedBaseline(
            normalizedAccountId,
            messagesByPeer,
            failedWriteAtStart,
            latestValueAtStart,
            generation,
          );
        }
        const stored = await this.options.store.get(normalizedAccountId);
        if (stored !== undefined) {
          const messagesByPeer = normalizeCloudMessagesByPeer(normalizedAccountId, stored);
          await this.writePeers(normalizedAccountId, messagesByPeer, [], [normalizedAccountId]);
          return this.establishLoadedBaseline(
            normalizedAccountId,
            messagesByPeer,
            failedWriteAtStart,
            latestValueAtStart,
            generation,
          );
        }
      } catch {
        // An unavailable local cache is repaired from the canonical chat sync
        // stream; browser localStorage is never a message-state fallback.
      }
    }
    return this.establishLoadedBaseline(
      normalizedAccountId,
      {},
      failedWriteAtStart,
      latestValueAtStart,
      generation,
    );
  }
  save(accountId: string, value: Record<string, CloudMessage[]>): Promise<void> {
    const normalizedAccountId = accountId.trim();
    if (!normalizedAccountId || !this.options.store) return Promise.resolve();
    const removal = this.activeRemovals.get(normalizedAccountId);
    if (removal) return removal.then(() => this.save(normalizedAccountId, value));
    const previous = this.latestValues.get(normalizedAccountId) ?? {};
    const peerIds = Object.keys(value).map(cleanText).filter(Boolean).sort();
    const changedPeers = new Map<string, CloudMessage[]>();
    for (const peerId of peerIds) {
      const messages = value[peerId] ?? [];
      if (previous[peerId] !== messages) changedPeers.set(peerId, messages);
    }
    const removedPeerIds = new Set(Object.keys(previous).filter((peerId) => (
      !Object.prototype.hasOwnProperty.call(value, peerId)
    )));
    this.latestValues.set(normalizedAccountId, { ...value });
    const pending = this.pendingWrites.get(normalizedAccountId);
    const failed = this.failedWrites.get(normalizedAccountId);
    if (
      changedPeers.size === 0
      && removedPeerIds.size === 0
      && !pending
      && !failed
      && !this.activeWrites.has(normalizedAccountId)
    ) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      if (pending) clearTimeout(pending.timer);
      const waiters = pending?.waiters ?? [];
      waiters.push({ resolve, reject });
      const pendingChangedPeers = pending?.changedPeers ?? new Map(failed?.changedPeers);
      const pendingRemovedPeerIds = pending?.removedPeerIds ?? new Set(failed?.removedPeerIds);
      if (failed) this.failedWrites.delete(normalizedAccountId);
      for (const peerId of removedPeerIds) {
        pendingChangedPeers.delete(peerId);
        pendingRemovedPeerIds.add(peerId);
      }
      for (const [peerId, messages] of changedPeers) {
        pendingChangedPeers.set(peerId, messages);
        pendingRemovedPeerIds.delete(peerId);
      }
      const timer = setTimeout(() => {
        const queued = this.pendingWrites.get(normalizedAccountId);
        if (queued) queued.ready = true;
        void this.flush(normalizedAccountId);
      }, this.options.debounceMs ?? 250);
      this.pendingWrites.set(normalizedAccountId, {
        changedPeers: pendingChangedPeers,
        removedPeerIds: pendingRemovedPeerIds,
        peerIds,
        timer,
        ready: false,
        waiters,
      });
    });
  }
  remove(accountId: string): Promise<void> {
    const normalizedAccountId = accountId.trim();
    if (!normalizedAccountId) return Promise.resolve();
    const activeRemoval = this.activeRemovals.get(normalizedAccountId);
    if (activeRemoval) return activeRemoval;
    let removal!: Promise<void>;
    removal = this.removeAccount(normalizedAccountId).finally(() => {
      if (this.activeRemovals.get(normalizedAccountId) === removal) {
        this.activeRemovals.delete(normalizedAccountId);
      }
    });
    this.activeRemovals.set(normalizedAccountId, removal);
    return removal;
  }
  private async removeAccount(accountId: string) {
    this.accountGenerations.set(accountId, (this.accountGenerations.get(accountId) ?? 0) + 1);
    const activeLoadSettlements: Promise<void>[] = [...(this.activeLoads.get(accountId) ?? [])]
      .map((loading) => loading.then(() => {}, () => {}));
    const activeWrite = this.activeWrites.get(accountId);
    if (activeWrite) activeLoadSettlements.push(activeWrite.settled);
    const pending = this.pendingWrites.get(accountId);
    if (pending) {
      clearTimeout(pending.timer);
      pending.waiters.forEach(({ resolve }) => resolve());
      this.pendingWrites.delete(accountId);
    }
    this.failedWrites.delete(accountId);
    this.latestValues.delete(accountId);
    await Promise.all(activeLoadSettlements);
    this.failedWrites.delete(accountId);
    this.latestValues.delete(accountId);
    if (this.options.store) {
      const manifest = cacheManifest(await this.options.store.get(manifestCacheKey(accountId)));
      await this.options.store.setMany(new Map(), [
        accountId,
        manifestCacheKey(accountId),
        ...(manifest?.peerIds ?? []).map((peerId) => peerCacheKey(accountId, peerId)),
      ]);
    }
  }
  private async flush(accountId: string) {
    const pending = this.pendingWrites.get(accountId);
    if (!pending || !this.options.store) return;
    if (this.activeWrites.has(accountId)) return;
    this.pendingWrites.delete(accountId);
    let settle!: () => void;
    const generation = this.accountGenerations.get(accountId) ?? 0;
    const activeWrite: ActiveWrite = {
      generation,
      settled: new Promise<void>((resolve) => { settle = resolve; }),
      settle: () => settle(),
    };
    this.activeWrites.set(accountId, activeWrite);
    try {
      const normalizedChangedPeers: Record<string, CloudMessage[]> = {};
      for (const [peerId, messages] of pending.changedPeers) {
        const normalized = normalizeCloudMessagesByPeer(accountId, { [peerId]: messages })[peerId];
        if (normalized?.length) normalizedChangedPeers[peerId] = normalized;
        else pending.removedPeerIds.add(peerId);
      }
      if (Object.keys(normalizedChangedPeers).length === 0 && pending.removedPeerIds.size === 0) {
        pending.waiters.forEach(({ resolve }) => resolve());
        return;
      }
      const peerIds = pending.peerIds.filter((peerId) => !pending.removedPeerIds.has(peerId));
      await this.writePeers(accountId, normalizedChangedPeers, [...pending.removedPeerIds], [], peerIds);
      pending.waiters.forEach(({ resolve }) => resolve());
    } catch (error) {
      if ((this.accountGenerations.get(accountId) ?? 0) === activeWrite.generation) {
        const failedChangedPeers = new Map<string, CloudMessage[]>(
          [...pending.changedPeers].filter(([peerId]) => !pending.removedPeerIds.has(peerId)),
        );
        const failedRemovedPeerIds = new Set(pending.removedPeerIds);
        const newer = this.pendingWrites.get(accountId);
        if (newer) {
          for (const peerId of newer.removedPeerIds) {
            failedChangedPeers.delete(peerId);
            failedRemovedPeerIds.add(peerId);
          }
          for (const [peerId, messages] of newer.changedPeers) {
            failedChangedPeers.set(peerId, messages);
            failedRemovedPeerIds.delete(peerId);
          }
          this.pendingWrites.set(accountId, {
            ...newer,
            changedPeers: failedChangedPeers,
            removedPeerIds: failedRemovedPeerIds,
          });
        } else {
          this.failedWrites.set(accountId, {
            changedPeers: failedChangedPeers,
            removedPeerIds: failedRemovedPeerIds,
          });
        }
      }
      pending.waiters.forEach(({ reject }) => reject(error));
    } finally {
      if (this.activeWrites.get(accountId) === activeWrite) this.activeWrites.delete(accountId);
      activeWrite.settle();
      if (!this.activeRemovals.has(accountId) && this.pendingWrites.get(accountId)?.ready) {
        void this.flush(accountId);
      }
    }
  }
  private establishLoadedBaseline(
    accountId: string,
    messagesByPeer: Record<string, CloudMessage[]>,
    failedWriteAtStart: RecoverableWrite | undefined,
    latestValueAtStart: Record<string, CloudMessage[]> | undefined,
    generation: number,
  ) {
    if ((this.accountGenerations.get(accountId) ?? 0) !== generation) return {};
    if (
      this.failedWrites.get(accountId) === failedWriteAtStart
      && this.latestValues.get(accountId) === latestValueAtStart
    ) {
      this.failedWrites.delete(accountId);
      this.latestValues.set(accountId, messagesByPeer);
    }
    return messagesByPeer;
  }
  private async writePeers(
    accountId: string,
    changedPeers: Record<string, CloudMessage[]>,
    removedPeerIds: readonly string[] = [],
    additionalRemoveKeys: readonly string[] = [],
    manifestPeerIds: readonly string[] = Object.keys(changedPeers),
  ) {
    if (!this.options.store) return;
    const entries = new Map<string, unknown>();
    const peerIds = [...new Set(manifestPeerIds.map(cleanText).filter(Boolean))].sort();
    entries.set(manifestCacheKey(accountId), {
      version: CLOUD_MESSAGE_CACHE_VERSION,
      peerIds,
    } satisfies CloudMessageCacheManifest);
    for (const [peerId, messages] of Object.entries(changedPeers)) {
      entries.set(peerCacheKey(accountId, peerId), {
        version: CLOUD_MESSAGE_CACHE_VERSION,
        peerId,
        messages,
      } satisfies CloudMessageCachePeerRecord);
    }
    await this.options.store.setMany(entries, [
      ...additionalRemoveKeys,
      ...removedPeerIds.map((peerId) => peerCacheKey(accountId, peerId)),
    ]);
  }
}
let defaultCache: CloudMessageCache | null = null;
export function defaultCloudMessageCache(): CloudMessageCache {
  if (defaultCache) return defaultCache;
  const factory = typeof indexedDB === 'undefined' ? null : indexedDB;
  defaultCache = new VersionedCloudMessageCache({
    store: factory ? new IndexedDbCloudMessageCacheStore(factory) : null,
  });
  return defaultCache;
}
