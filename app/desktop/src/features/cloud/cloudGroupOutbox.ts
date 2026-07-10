import type { SendCloudMessageAttachmentInput } from './authClient';
import type { CanonicalSessionMessage, CanonicalSessionState } from '@/kordi-app/types';

export const CLOUD_GROUP_OUTBOX_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 15_000, 30_000] as const;
export const CLOUD_GROUP_OUTBOX_MAX_ATTEMPTS = CLOUD_GROUP_OUTBOX_RETRY_DELAYS_MS.length + 1;

const CLOUD_GROUP_OUTBOX_VERSION = 1 as const;
const CLOUD_GROUP_OUTBOX_DATABASE = 'kordi-cloud-group-outbox-v1';
const CLOUD_GROUP_OUTBOX_STORE = 'outboxByAccount';
const CLOUD_GROUP_OUTBOX_LOCAL_STORAGE_PREFIX = 'kordi.cloud.groupOutbox.v1:';
const MAX_COMPLETED_MESSAGE_IDS = 1_000;

export type CloudGroupOutboxEntry = {
  canonicalMessageId: string;
  sessionId: string;
  envelope: string;
  trackCanonicalDelivery?: boolean;
  attachments?: SendCloudMessageAttachmentInput[];
  clientCreatedAt?: string | null;
  pendingRecipientIds: string[];
  deliveredRecipientIds: string[];
  exhaustedRecipientIds?: string[];
  attemptsByRecipientId: Record<string, number>;
  nextAttemptAtMs: number;
};

export type CloudGroupOutboxPersistedState = {
  version: typeof CLOUD_GROUP_OUTBOX_VERSION;
  entries: CloudGroupOutboxEntry[];
  completedCanonicalMessageIds: string[];
};

export interface CloudGroupOutboxPersistence {
  load(): Promise<CloudGroupOutboxPersistedState | null>;
  save(value: CloudGroupOutboxPersistedState): Promise<void>;
}

export type CloudGroupOutboxDelivery = {
  recipientId: string;
  clientMessageId: string;
  entry: CloudGroupOutboxEntry;
};

export type CloudGroupOutboxSend = (delivery: CloudGroupOutboxDelivery) => Promise<unknown>;

export function cloudGroupOutboxDeliveryStatus(entry: CloudGroupOutboxEntry) {
  const deliveredRecipientIds = [...entry.deliveredRecipientIds];
  const pendingRecipientIds = [...entry.pendingRecipientIds];
  const exhaustedRecipientIds = [...(entry.exhaustedRecipientIds ?? [])];
  const hasDelivered = deliveredRecipientIds.length > 0;
  const hasPending = pendingRecipientIds.length > 0;
  const hasExhausted = exhaustedRecipientIds.length > 0;
  const status = !hasDelivered && !hasPending && hasExhausted
    ? 'failed'
    : hasDelivered
      ? 'delivered'
      : 'sending';
  const deliveryState = status === 'failed'
    ? 'failed'
    : hasDelivered && (hasPending || hasExhausted)
      ? 'partial'
      : hasDelivered
        ? 'delivered'
        : 'sending';
  return { status, deliveryState, deliveredRecipientIds, pendingRecipientIds, exhaustedRecipientIds };
}

export function patchCanonicalCloudGroupOutboxDelivery(
  state: CanonicalSessionState | null,
  entry: CloudGroupOutboxEntry,
): CanonicalSessionState | null {
  if (!state) return state;
  const index = state.messages.findIndex((message) => (
    message.id === entry.canonicalMessageId && message.sessionId === entry.sessionId
  ));
  if (index < 0) return state;
  const delivery = cloudGroupOutboxDeliveryStatus(entry);
  const previous = state.messages[index];
  const previousContent = previous.content && typeof previous.content === 'object' && !Array.isArray(previous.content)
    ? previous.content as Record<string, unknown>
    : {};
  const message: CanonicalSessionMessage = {
    ...previous,
    status: delivery.status,
    content: {
      ...previousContent,
      deliveryState: delivery.deliveryState,
      deliveredRecipientIds: delivery.deliveredRecipientIds,
      pendingRecipientIds: delivery.pendingRecipientIds,
      exhaustedRecipientIds: delivery.exhaustedRecipientIds,
    },
    updatedAtMs: Date.now(),
  };
  const messages = [...state.messages];
  messages[index] = message;
  return { ...state, messages };
}

function cleanText(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function uniqueText(values: unknown) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(cleanText).filter(Boolean))];
}

function normalizedAttempts(value: unknown, recipientIds: Set<string>) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, number> = {};
  for (const [recipientId, attempts] of Object.entries(value)) {
    const normalizedRecipientId = recipientId.trim();
    if (!recipientIds.has(normalizedRecipientId)) continue;
    if (typeof attempts !== 'number' || !Number.isFinite(attempts) || attempts < 0) continue;
    result[normalizedRecipientId] = Math.min(CLOUD_GROUP_OUTBOX_MAX_ATTEMPTS, Math.floor(attempts));
  }
  return result;
}

function normalizedAttachments(value: unknown): SendCloudMessageAttachmentInput[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const attachments = value.flatMap((candidate): SendCloudMessageAttachmentInput[] => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const record = candidate as Record<string, unknown>;
    const attachmentId = cleanText(record.attachmentId);
    const name = cleanText(record.name);
    const kind = record.kind === 'image' || record.kind === 'file' ? record.kind : null;
    if (!attachmentId || !name || !kind) return [];
    return [{
      attachmentId,
      name,
      kind,
      mimeType: cleanText(record.mimeType) || null,
      sizeBytes: typeof record.sizeBytes === 'number' && Number.isFinite(record.sizeBytes)
        ? record.sizeBytes
        : null,
    }];
  });
  return attachments.length > 0 ? attachments : undefined;
}

function normalizeEntry(value: unknown): CloudGroupOutboxEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const canonicalMessageId = cleanText(record.canonicalMessageId);
  const sessionId = cleanText(record.sessionId);
  const envelope = cleanText(record.envelope);
  if (!canonicalMessageId || !sessionId || !envelope) return null;

  const deliveredRecipientIds = uniqueText(record.deliveredRecipientIds);
  const exhaustedRecipientIds = uniqueText(record.exhaustedRecipientIds);
  const terminalIds = new Set([...deliveredRecipientIds, ...exhaustedRecipientIds]);
  const pendingRecipientIds = uniqueText(record.pendingRecipientIds).filter((id) => !terminalIds.has(id));
  const allRecipientIds = new Set([...pendingRecipientIds, ...deliveredRecipientIds, ...exhaustedRecipientIds]);
  if (allRecipientIds.size === 0) return null;
  const clientCreatedAt = cleanText(record.clientCreatedAt);
  const attachments = normalizedAttachments(record.attachments);

  return {
    canonicalMessageId,
    sessionId,
    envelope,
    trackCanonicalDelivery: record.trackCanonicalDelivery !== false,
    ...(attachments ? { attachments } : {}),
    ...(clientCreatedAt ? { clientCreatedAt } : {}),
    pendingRecipientIds,
    deliveredRecipientIds,
    ...(exhaustedRecipientIds.length > 0 ? { exhaustedRecipientIds } : {}),
    attemptsByRecipientId: normalizedAttempts(record.attemptsByRecipientId, allRecipientIds),
    nextAttemptAtMs: typeof record.nextAttemptAtMs === 'number' && Number.isFinite(record.nextAttemptAtMs)
      ? Math.max(0, record.nextAttemptAtMs)
      : 0,
  };
}

function normalizeState(value: unknown): CloudGroupOutboxPersistedState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { version: CLOUD_GROUP_OUTBOX_VERSION, entries: [], completedCanonicalMessageIds: [] };
  }
  const record = value as Record<string, unknown>;
  const completedCanonicalMessageIds = uniqueText(record.completedCanonicalMessageIds).slice(-MAX_COMPLETED_MESSAGE_IDS);
  const completed = new Set(completedCanonicalMessageIds);
  const entries = Array.isArray(record.entries)
    ? record.entries
        .map(normalizeEntry)
        .filter((entry): entry is CloudGroupOutboxEntry => entry !== null && !completed.has(entry.canonicalMessageId))
    : [];
  return { version: CLOUD_GROUP_OUTBOX_VERSION, entries, completedCanonicalMessageIds };
}

function cloneEntry(entry: CloudGroupOutboxEntry): CloudGroupOutboxEntry {
  return {
    ...entry,
    attachments: entry.attachments?.map((attachment) => ({ ...attachment })),
    pendingRecipientIds: [...entry.pendingRecipientIds],
    deliveredRecipientIds: [...entry.deliveredRecipientIds],
    exhaustedRecipientIds: entry.exhaustedRecipientIds ? [...entry.exhaustedRecipientIds] : undefined,
    attemptsByRecipientId: { ...entry.attemptsByRecipientId },
  };
}

function cloneState(state: CloudGroupOutboxPersistedState): CloudGroupOutboxPersistedState {
  return {
    version: CLOUD_GROUP_OUTBOX_VERSION,
    entries: state.entries.map(cloneEntry),
    completedCanonicalMessageIds: [...state.completedCanonicalMessageIds],
  };
}

export class CloudGroupOutbox {
  private state: CloudGroupOutboxPersistedState = {
    version: CLOUD_GROUP_OUTBOX_VERSION,
    entries: [],
    completedCanonicalMessageIds: [],
  };

  private restored = false;
  private restorePromise: Promise<CloudGroupOutboxEntry[]> | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly inFlight = new Map<string, Promise<CloudGroupOutboxEntry | null>>();
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly accountId: string,
    private readonly persistence: CloudGroupOutboxPersistence,
  ) {}

  async restore() {
    if (this.restored) return this.entries();
    if (this.restorePromise) return this.restorePromise;
    this.restorePromise = (async () => {
      this.state = normalizeState(await this.persistence.load());
      this.restored = true;
      this.notify();
      return this.entries();
    })();
    try {
      return await this.restorePromise;
    } finally {
      this.restorePromise = null;
    }
  }

  entries() {
    return this.state.entries.map(cloneEntry);
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async enqueue(value: CloudGroupOutboxEntry) {
    await this.ensureRestored();
    const entry = normalizeEntry(value);
    if (!entry) throw new Error('Cloud group outbox entry is invalid.');
    if (this.state.completedCanonicalMessageIds.includes(entry.canonicalMessageId)) return null;
    const existing = this.state.entries.find((candidate) => candidate.canonicalMessageId === entry.canonicalMessageId);
    if (existing) return cloneEntry(existing);
    this.state.entries.push(entry);
    await this.persist();
    return cloneEntry(entry);
  }

  async deliver(
    canonicalMessageId: string,
    send: CloudGroupOutboxSend,
    options: { nowMs?: number; force?: boolean } = {},
  ): Promise<CloudGroupOutboxEntry | null> {
    await this.ensureRestored();
    const normalizedId = canonicalMessageId.trim();
    if (!normalizedId) return null;
    const existingFlight = this.inFlight.get(normalizedId);
    if (existingFlight) return existingFlight;
    const delivery = this.deliverOnce(normalizedId, send, options);
    this.inFlight.set(normalizedId, delivery);
    try {
      return await delivery;
    } finally {
      this.inFlight.delete(normalizedId);
    }
  }

  async deliverDue(send: CloudGroupOutboxSend, nowMs = Date.now()) {
    await this.ensureRestored();
    const dueIds = this.state.entries
      .filter((entry) => entry.pendingRecipientIds.length > 0 && entry.nextAttemptAtMs <= nowMs)
      .map((entry) => entry.canonicalMessageId);
    return Promise.all(dueIds.map((id) => this.deliver(id, send, { nowMs })));
  }

  private async deliverOnce(
    canonicalMessageId: string,
    send: CloudGroupOutboxSend,
    options: { nowMs?: number; force?: boolean },
  ) {
    const entry = this.state.entries.find((candidate) => candidate.canonicalMessageId === canonicalMessageId);
    if (!entry || entry.pendingRecipientIds.length === 0) return entry ? cloneEntry(entry) : null;
    const nowMs = options.nowMs ?? Date.now();
    if (!options.force && entry.nextAttemptAtMs > nowMs) return cloneEntry(entry);

    const pendingAtStart = [...entry.pendingRecipientIds];
    const outcomes = await Promise.allSettled(pendingAtStart.map(async (recipientId) => {
      await send({
        recipientId,
        clientMessageId: `${entry.canonicalMessageId}:${recipientId}`,
        entry: cloneEntry(entry),
      });
      return recipientId;
    }));
    const delivered = new Set(entry.deliveredRecipientIds);
    const exhausted = new Set(entry.exhaustedRecipientIds ?? []);
    const pending = new Set(entry.pendingRecipientIds);

    outcomes.forEach((outcome, index) => {
      const recipientId = pendingAtStart[index];
      if (!recipientId) return;
      if (outcome.status === 'fulfilled') {
        pending.delete(recipientId);
        exhausted.delete(recipientId);
        delivered.add(recipientId);
        return;
      }
      const attempts = (entry.attemptsByRecipientId[recipientId] ?? 0) + 1;
      entry.attemptsByRecipientId[recipientId] = attempts;
      if (attempts >= CLOUD_GROUP_OUTBOX_MAX_ATTEMPTS) {
        pending.delete(recipientId);
        exhausted.add(recipientId);
      }
    });

    entry.pendingRecipientIds = [...pending];
    entry.deliveredRecipientIds = [...delivered];
    entry.exhaustedRecipientIds = exhausted.size > 0 ? [...exhausted] : undefined;
    const retryDelays = entry.pendingRecipientIds.map((recipientId) => {
      const attempts = Math.max(1, entry.attemptsByRecipientId[recipientId] ?? 1);
      return CLOUD_GROUP_OUTBOX_RETRY_DELAYS_MS[Math.min(attempts - 1, CLOUD_GROUP_OUTBOX_RETRY_DELAYS_MS.length - 1)];
    });
    entry.nextAttemptAtMs = retryDelays.length > 0 ? nowMs + Math.min(...retryDelays) : 0;
    const outcome = cloneEntry(entry);

    if (entry.pendingRecipientIds.length === 0 && (entry.exhaustedRecipientIds?.length ?? 0) === 0) {
      this.state.entries = this.state.entries.filter((candidate) => candidate.canonicalMessageId !== canonicalMessageId);
      this.state.completedCanonicalMessageIds = [
        ...this.state.completedCanonicalMessageIds.filter((id) => id !== canonicalMessageId),
        canonicalMessageId,
      ].slice(-MAX_COMPLETED_MESSAGE_IDS);
    }
    await this.persist();
    this.notify();
    return outcome;
  }

  private async ensureRestored() {
    if (!this.restored) await this.restore();
  }

  private persist() {
    const snapshot = cloneState(this.state);
    this.writeChain = this.writeChain.catch(() => {}).then(() => this.persistence.save(snapshot));
    return this.writeChain;
  }

  private notify() {
    this.listeners.forEach((listener) => listener());
  }
}

class BrowserCloudGroupOutboxPersistence implements CloudGroupOutboxPersistence {
  private database: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly accountId: string,
    private readonly factory: IDBFactory | null,
    private readonly storage: Storage | null,
  ) {}

  async load() {
    if (this.factory) {
      try {
        const value = await this.request('readonly', (store) => store.get(this.accountId));
        if (value !== undefined) return normalizeState(value);
      } catch {
        // Fall through to localStorage when IndexedDB is temporarily unavailable.
      }
    }
    try {
      const raw = this.storage?.getItem(`${CLOUD_GROUP_OUTBOX_LOCAL_STORAGE_PREFIX}${this.accountId}`);
      return raw ? normalizeState(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  }

  async save(value: CloudGroupOutboxPersistedState) {
    if (this.factory) {
      try {
        await this.request('readwrite', (store) => store.put(value, this.accountId));
        this.storage?.removeItem(`${CLOUD_GROUP_OUTBOX_LOCAL_STORAGE_PREFIX}${this.accountId}`);
        return;
      } catch {
        // Preserve the outbox in localStorage so a transient IDB failure does
        // not silently turn a queued send into a memory-only operation.
      }
    }
    this.storage?.setItem(`${CLOUD_GROUP_OUTBOX_LOCAL_STORAGE_PREFIX}${this.accountId}`, JSON.stringify(value));
  }

  private open() {
    if (!this.factory) return Promise.reject(new Error('IndexedDB is unavailable.'));
    if (this.database) return this.database;
    this.database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.factory!.open(CLOUD_GROUP_OUTBOX_DATABASE, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(CLOUD_GROUP_OUTBOX_STORE)) {
          request.result.createObjectStore(CLOUD_GROUP_OUTBOX_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Unable to open the Cloud group outbox.'));
    });
    return this.database;
  }

  private async request<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>) {
    const database = await this.open();
    return new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(CLOUD_GROUP_OUTBOX_STORE, mode);
      const request = run(transaction.objectStore(CLOUD_GROUP_OUTBOX_STORE));
      let result: T;
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => reject(request.error ?? new Error('Cloud group outbox request failed.'));
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(transaction.error ?? new Error('Cloud group outbox transaction aborted.'));
      transaction.onerror = () => reject(transaction.error ?? new Error('Cloud group outbox transaction failed.'));
    });
  }
}

function browserStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

export function defaultCloudGroupOutboxPersistence(accountId: string): CloudGroupOutboxPersistence {
  return new BrowserCloudGroupOutboxPersistence(
    accountId.trim(),
    typeof indexedDB === 'undefined' ? null : indexedDB,
    browserStorage(),
  );
}
