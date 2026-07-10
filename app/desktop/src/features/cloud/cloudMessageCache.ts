import type { CloudMessage, CloudMessageAttachment } from './authClient';

export const CLOUD_MESSAGES_LEGACY_CACHE_PREFIX = 'kordi.cloud.messagesByPeer.v1:';
export const CLOUD_MESSAGES_INDEXED_DB_NAME = 'kordi-cloud-message-cache-v2';
const CLOUD_MESSAGES_INDEXED_DB_STORE = 'messagesByAccount';
const CLOUD_MESSAGE_CACHE_VERSION = 2;

export interface CloudMessageCache {
  load(accountId: string): Promise<Record<string, CloudMessage[]>>;
  save(accountId: string, value: Record<string, CloudMessage[]>): Promise<void>;
  remove(accountId: string): Promise<void>;
}

export interface CloudMessageCacheStore {
  get(accountId: string): Promise<unknown | undefined>;
  set(accountId: string, value: unknown): Promise<void>;
  remove(accountId: string): Promise<void>;
}

type CloudMessageCacheRecord = {
  version: typeof CLOUD_MESSAGE_CACHE_VERSION;
  messagesByPeer: Record<string, CloudMessage[]>;
};

type PendingWrite = {
  value: Record<string, CloudMessage[]>;
  timer: ReturnType<typeof setTimeout>;
  waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
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
  const source = record.version === CLOUD_MESSAGE_CACHE_VERSION
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

  async set(accountId: string, value: unknown) {
    await this.request('readwrite', (store) => store.put(value, accountId));
  }

  async remove(accountId: string) {
    await this.request('readwrite', (store) => store.delete(accountId));
  }
}

export class VersionedCloudMessageCache implements CloudMessageCache {
  private readonly pendingWrites = new Map<string, PendingWrite>();

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
        const stored = await this.options.store.get(normalizedAccountId);
        if (stored !== undefined) return normalizeCloudMessagesByPeer(normalizedAccountId, stored);
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
        await this.options.store.set(normalizedAccountId, {
          version: CLOUD_MESSAGE_CACHE_VERSION,
          messagesByPeer,
        } satisfies CloudMessageCacheRecord);
        legacyStorage?.removeItem(legacyCacheKey(normalizedAccountId));
      } catch {
        // Keep the legacy value so a later load can retry migration.
      }
    }
    return messagesByPeer;
  }

  save(accountId: string, value: Record<string, CloudMessage[]>): Promise<void> {
    const normalizedAccountId = accountId.trim();
    if (!normalizedAccountId || !this.options.store) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const pending = this.pendingWrites.get(normalizedAccountId);
      if (pending) clearTimeout(pending.timer);
      const waiters = pending?.waiters ?? [];
      waiters.push({ resolve, reject });
      const timer = setTimeout(() => {
        void this.flush(normalizedAccountId);
      }, this.options.debounceMs ?? 250);
      this.pendingWrites.set(normalizedAccountId, { value, timer, waiters });
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
    await this.options.store?.remove(normalizedAccountId);
    try {
      this.options.legacyStorage?.removeItem(legacyCacheKey(normalizedAccountId));
    } catch {
      // Best effort cleanup.
    }
  }

  private async flush(accountId: string) {
    const pending = this.pendingWrites.get(accountId);
    if (!pending || !this.options.store) return;
    this.pendingWrites.delete(accountId);
    try {
      const messagesByPeer = normalizeCloudMessagesByPeer(accountId, pending.value);
      await this.options.store.set(accountId, {
        version: CLOUD_MESSAGE_CACHE_VERSION,
        messagesByPeer,
      } satisfies CloudMessageCacheRecord);
      pending.waiters.forEach(({ resolve }) => resolve());
    } catch (error) {
      pending.waiters.forEach(({ reject }) => reject(error));
    }
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
