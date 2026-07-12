import type { CloudMessage, CloudMessageAttachment } from './authClient';

export const CLOUD_MESSAGES_LEGACY_CACHE_PREFIX = 'kordi.cloud.messagesByPeer.v1:';
export const CLOUD_MESSAGES_INDEXED_DB_NAME = 'kordi-cloud-message-cache-v2';
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
  return {
    attachmentId,
    name,
    kind,
    mimeType,
    sizeBytes,
    ...(previewAttachmentId ? { previewAttachmentId } : {}),
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

function legacyCacheKey(accountId: string) {
  return `${CLOUD_MESSAGES_LEGACY_CACHE_PREFIX}${accountId}`;
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

function browserLocalStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
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
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Unable to open Cloud message cache.'));
    });
    return this.database;
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
  private readonly activeWrites = new Set<string>();
  private readonly failedWrites = new Map<string, RecoverableWrite>();
  private readonly latestValues = new Map<string, Record<string, CloudMessage[]>>();

  constructor(private readonly options: {
    store: CloudMessageCacheStore | null;
    legacyStorage?: Storage | null;
    debounceMs?: number;
  }) {}

  async load(accountId: string) {
    const normalizedAccountId = accountId.trim();
    if (!normalizedAccountId) return {};
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
          this.latestValues.set(normalizedAccountId, messagesByPeer);
          return messagesByPeer;
        }
        const stored = await this.options.store.get(normalizedAccountId);
        if (stored !== undefined) {
          const messagesByPeer = normalizeCloudMessagesByPeer(normalizedAccountId, stored);
          await this.writePeers(normalizedAccountId, messagesByPeer, [], [normalizedAccountId]);
          this.latestValues.set(normalizedAccountId, messagesByPeer);
          return messagesByPeer;
        }
      } catch {
        // Fall through to the legacy snapshot when IndexedDB is unavailable.
      }
    }

    const legacyStorage = this.options.legacyStorage ?? null;
    let legacyValue: unknown = {};
    try {
      const raw = legacyStorage?.getItem(legacyCacheKey(normalizedAccountId));
      legacyValue = raw ? JSON.parse(raw) : {};
    } catch {
      legacyValue = {};
    }
    const messagesByPeer = normalizeCloudMessagesByPeer(normalizedAccountId, legacyValue);
    if (this.options.store) {
      try {
        await this.writePeers(normalizedAccountId, messagesByPeer, [], [normalizedAccountId]);
        legacyStorage?.removeItem(legacyCacheKey(normalizedAccountId));
      } catch {
        // Keep the legacy value so a later load can retry migration.
      }
    }
    this.latestValues.set(normalizedAccountId, messagesByPeer);
    return messagesByPeer;
  }

  save(accountId: string, value: Record<string, CloudMessage[]>): Promise<void> {
    const normalizedAccountId = accountId.trim();
    if (!normalizedAccountId || !this.options.store) return Promise.resolve();
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

  async remove(accountId: string) {
    const normalizedAccountId = accountId.trim();
    if (!normalizedAccountId) return;
    const pending = this.pendingWrites.get(normalizedAccountId);
    if (pending) {
      clearTimeout(pending.timer);
      pending.waiters.forEach(({ resolve }) => resolve());
      this.pendingWrites.delete(normalizedAccountId);
    }
    this.failedWrites.delete(normalizedAccountId);
    this.latestValues.delete(normalizedAccountId);
    if (this.options.store) {
      const manifest = cacheManifest(await this.options.store.get(manifestCacheKey(normalizedAccountId)));
      await this.options.store.setMany(new Map(), [
        normalizedAccountId,
        manifestCacheKey(normalizedAccountId),
        ...(manifest?.peerIds ?? []).map((peerId) => peerCacheKey(normalizedAccountId, peerId)),
      ]);
    }
    try {
      this.options.legacyStorage?.removeItem(legacyCacheKey(normalizedAccountId));
    } catch {
      // Best effort cleanup.
    }
  }

  private async flush(accountId: string) {
    const pending = this.pendingWrites.get(accountId);
    if (!pending || !this.options.store) return;
    if (this.activeWrites.has(accountId)) return;
    this.pendingWrites.delete(accountId);
    this.activeWrites.add(accountId);
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
      pending.waiters.forEach(({ reject }) => reject(error));
    } finally {
      this.activeWrites.delete(accountId);
      if (this.pendingWrites.get(accountId)?.ready) void this.flush(accountId);
    }
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
    legacyStorage: browserLocalStorage(),
  });
  return defaultCache;
}
