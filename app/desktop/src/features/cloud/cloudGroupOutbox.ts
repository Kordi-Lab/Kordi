import type { SendCloudMessageAttachmentInput } from './authClient';
import type { CanonicalSessionMessage, CanonicalSessionState } from '@/kordi-app/types';
import {
  normalizedCloudGroupOutboxAttachments,
  normalizedCloudGroupOutboxPendingAttachments,
  type CloudGroupOutboxAttachmentSource,
} from './cloudGroupOutboxAttachmentCodec';

export type { CloudGroupOutboxAttachmentSource } from './cloudGroupOutboxAttachmentCodec';

export const CLOUD_GROUP_OUTBOX_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 15_000, 30_000] as const;
export const CLOUD_GROUP_OUTBOX_MAX_ATTEMPTS = CLOUD_GROUP_OUTBOX_RETRY_DELAYS_MS.length + 1;
export const CLOUD_GROUP_CANONICAL_RECONCILE_DELAY_MS = 1_000;

const CLOUD_GROUP_OUTBOX_VERSION = 1 as const;
const CLOUD_GROUP_OUTBOX_DATABASE = 'kordi-cloud-group-outbox-v1';
const CLOUD_GROUP_OUTBOX_STORE = 'outboxByAccount';
const CLOUD_GROUP_OUTBOX_LOCAL_STORAGE_PREFIX = 'kordi.cloud.groupOutbox.v1:';
const MAX_COMPLETED_MESSAGE_IDS = 1_000;

export type CloudGroupOutboxEntry = {
  canonicalMessageId: string;
  sessionId: string;
  envelope: string;
  awaitingCanonicalAck?: boolean;
  trackCanonicalDelivery?: boolean;
  attachments?: SendCloudMessageAttachmentInput[];
  pendingAttachments?: CloudGroupOutboxAttachmentSource[];
  payloadVersion?: number;
  deliveryGeneration?: number;
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

export function cloudGroupOutboxNextWakeAtMs(
  entries: readonly CloudGroupOutboxEntry[],
  nowMs = Date.now(),
): number | null {
  const nextWakeAtMs = entries.reduce((earliest, entry) => {
    if (entry.awaitingCanonicalAck === true) {
      return Math.min(earliest, nowMs + CLOUD_GROUP_CANONICAL_RECONCILE_DELAY_MS);
    }
    if (entry.pendingRecipientIds.length > 0) {
      return Math.min(earliest, entry.nextAttemptAtMs);
    }
    return earliest;
  }, Number.POSITIVE_INFINITY);
  return Number.isFinite(nextWakeAtMs) ? nextWakeAtMs : null;
}

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
  return { status, deliveryState, deliveredRecipientIds, pendingRecipientIds, exhaustedRecipientIds } as const;
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
  const awaitingCanonicalAck = record.awaitingCanonicalAck === true
    && pendingRecipientIds.length === 0
    && deliveredRecipientIds.length > 0
    && exhaustedRecipientIds.length === 0;
  const clientCreatedAt = cleanText(record.clientCreatedAt);
  const attachments = normalizedCloudGroupOutboxAttachments(record.attachments);
  const pendingAttachments = normalizedCloudGroupOutboxPendingAttachments(record.pendingAttachments);
  const payloadVersion = typeof record.payloadVersion === 'number' && Number.isFinite(record.payloadVersion)
    ? Math.max(0, Math.floor(record.payloadVersion))
    : 0;
  const deliveryGeneration = typeof record.deliveryGeneration === 'number' && Number.isFinite(record.deliveryGeneration)
    ? Math.max(0, Math.floor(record.deliveryGeneration))
    : 0;

  return {
    canonicalMessageId,
    sessionId,
    envelope,
    awaitingCanonicalAck,
    trackCanonicalDelivery: record.trackCanonicalDelivery !== false,
    ...(attachments ? { attachments } : {}),
    ...(pendingAttachments ? { pendingAttachments } : {}),
    ...(payloadVersion > 0 ? { payloadVersion } : {}),
    ...(deliveryGeneration > 0 ? { deliveryGeneration } : {}),
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

function cappedCompletedCanonicalMessageIds(values: string[], prioritizedIds = new Set<string>()) {
  const completedCanonicalMessageIds = uniqueText(values);
  const prioritized = completedCanonicalMessageIds
    .filter((canonicalMessageId) => prioritizedIds.has(canonicalMessageId))
    .slice(-MAX_COMPLETED_MESSAGE_IDS);
  const remainingCount = MAX_COMPLETED_MESSAGE_IDS - prioritized.length;
  const remaining = remainingCount > 0
    ? completedCanonicalMessageIds
        .filter((canonicalMessageId) => !prioritizedIds.has(canonicalMessageId))
        .slice(-remainingCount)
    : [];
  return [...remaining, ...prioritized];
}

function mergeEntries(
  indexedDbEntry: CloudGroupOutboxEntry,
  fallbackEntry: CloudGroupOutboxEntry,
): CloudGroupOutboxEntry {
  const indexedDbDeliveryGeneration = indexedDbEntry.deliveryGeneration ?? 0;
  const fallbackDeliveryGeneration = fallbackEntry.deliveryGeneration ?? 0;
  const newestDeliveryEntry = indexedDbDeliveryGeneration > fallbackDeliveryGeneration
    ? indexedDbEntry
    : fallbackDeliveryGeneration > indexedDbDeliveryGeneration
      ? fallbackEntry
      : null;
  const deliveredRecipientIds = newestDeliveryEntry
    ? uniqueText(newestDeliveryEntry.deliveredRecipientIds)
    : uniqueText([
        ...indexedDbEntry.deliveredRecipientIds,
        ...fallbackEntry.deliveredRecipientIds,
      ]);
  const delivered = new Set(deliveredRecipientIds);
  const exhaustedRecipientIds = (newestDeliveryEntry
    ? uniqueText(newestDeliveryEntry.exhaustedRecipientIds ?? [])
    : uniqueText([
        ...(indexedDbEntry.exhaustedRecipientIds ?? []),
        ...(fallbackEntry.exhaustedRecipientIds ?? []),
      ])).filter((recipientId) => !delivered.has(recipientId));
  const terminal = new Set([...deliveredRecipientIds, ...exhaustedRecipientIds]);
  const pendingRecipientIds = (newestDeliveryEntry
    ? uniqueText(newestDeliveryEntry.pendingRecipientIds)
    : uniqueText([
        ...indexedDbEntry.pendingRecipientIds,
        ...fallbackEntry.pendingRecipientIds,
      ])).filter((recipientId) => !terminal.has(recipientId));
  const recipientIds = new Set([
    ...pendingRecipientIds,
    ...deliveredRecipientIds,
    ...exhaustedRecipientIds,
  ]);
  const attemptsByRecipientId: Record<string, number> = {};
  for (const recipientId of recipientIds) {
    attemptsByRecipientId[recipientId] = newestDeliveryEntry
      ? newestDeliveryEntry.attemptsByRecipientId[recipientId] ?? 0
      : Math.max(
          indexedDbEntry.attemptsByRecipientId[recipientId] ?? 0,
          fallbackEntry.attemptsByRecipientId[recipientId] ?? 0,
        );
  }
  const awaitingCanonicalAck = (newestDeliveryEntry
    ? newestDeliveryEntry.awaitingCanonicalAck === true
    : indexedDbEntry.awaitingCanonicalAck === true || fallbackEntry.awaitingCanonicalAck === true)
    && pendingRecipientIds.length === 0
    && deliveredRecipientIds.length > 0
    && exhaustedRecipientIds.length === 0;
  const indexedDbUploadComplete = !indexedDbEntry.pendingAttachments?.length
    && (indexedDbEntry.attachments?.length ?? 0) > 0;
  const fallbackUploadComplete = !fallbackEntry.pendingAttachments?.length
    && (fallbackEntry.attachments?.length ?? 0) > 0;
  const indexedDbPayloadVersion = indexedDbEntry.payloadVersion ?? 0;
  const fallbackPayloadVersion = fallbackEntry.payloadVersion ?? 0;
  const payloadEntry = indexedDbPayloadVersion > fallbackPayloadVersion
    ? indexedDbEntry
    : fallbackPayloadVersion > indexedDbPayloadVersion
      ? fallbackEntry
      : indexedDbUploadComplete && !fallbackUploadComplete
        ? indexedDbEntry
        : fallbackEntry;

  return {
    ...indexedDbEntry,
    ...fallbackEntry,
    envelope: payloadEntry.envelope,
    attachments: payloadEntry.attachments?.map((attachment) => ({ ...attachment })),
    pendingAttachments: payloadEntry.pendingAttachments?.map((attachment) => ({ ...attachment })),
    ...(payloadEntry.payloadVersion ? { payloadVersion: payloadEntry.payloadVersion } : { payloadVersion: undefined }),
    ...(Math.max(indexedDbDeliveryGeneration, fallbackDeliveryGeneration) > 0
      ? { deliveryGeneration: Math.max(indexedDbDeliveryGeneration, fallbackDeliveryGeneration) }
      : { deliveryGeneration: undefined }),
    awaitingCanonicalAck,
    trackCanonicalDelivery: newestDeliveryEntry
      ? newestDeliveryEntry.trackCanonicalDelivery !== false
      : indexedDbEntry.trackCanonicalDelivery !== false && fallbackEntry.trackCanonicalDelivery !== false,
    pendingRecipientIds,
    deliveredRecipientIds,
    ...(exhaustedRecipientIds.length > 0 ? { exhaustedRecipientIds } : { exhaustedRecipientIds: undefined }),
    attemptsByRecipientId,
    nextAttemptAtMs: pendingRecipientIds.length > 0
      ? newestDeliveryEntry?.nextAttemptAtMs
        ?? Math.max(indexedDbEntry.nextAttemptAtMs, fallbackEntry.nextAttemptAtMs)
      : 0,
  };
}

function mergeStates(
  indexedDbState: CloudGroupOutboxPersistedState,
  fallbackState: CloudGroupOutboxPersistedState,
): CloudGroupOutboxPersistedState {
  const allCompletedCanonicalMessageIds = uniqueText([
    ...indexedDbState.completedCanonicalMessageIds,
    ...fallbackState.completedCanonicalMessageIds,
  ]);
  const completed = new Set(allCompletedCanonicalMessageIds);
  const entryCanonicalMessageIds = new Set([
    ...indexedDbState.entries.map((entry) => entry.canonicalMessageId),
    ...fallbackState.entries.map((entry) => entry.canonicalMessageId),
  ]);
  const entriesByCanonicalMessageId = new Map(
    indexedDbState.entries.map((entry) => [entry.canonicalMessageId, cloneEntry(entry)]),
  );
  for (const fallbackEntry of fallbackState.entries) {
    const indexedDbEntry = entriesByCanonicalMessageId.get(fallbackEntry.canonicalMessageId);
    entriesByCanonicalMessageId.set(
      fallbackEntry.canonicalMessageId,
      indexedDbEntry ? mergeEntries(indexedDbEntry, fallbackEntry) : cloneEntry(fallbackEntry),
    );
  }
  const entries = [...entriesByCanonicalMessageId.values()]
    .filter((entry) => !completed.has(entry.canonicalMessageId));
  const completedCanonicalMessageIds = cappedCompletedCanonicalMessageIds(
    allCompletedCanonicalMessageIds,
    entryCanonicalMessageIds,
  );
  return { version: CLOUD_GROUP_OUTBOX_VERSION, entries, completedCanonicalMessageIds };
}

function cloneEntry(entry: CloudGroupOutboxEntry): CloudGroupOutboxEntry {
  return {
    ...entry,
    awaitingCanonicalAck: entry.awaitingCanonicalAck === true,
    attachments: entry.attachments?.map((attachment) => ({ ...attachment })),
    pendingAttachments: entry.pendingAttachments?.map((attachment) => ({ ...attachment })),
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

type CloudGroupOutboxStateMutation = {
  apply(state: CloudGroupOutboxPersistedState): unknown;
};

export class CloudGroupOutbox {
  private state: CloudGroupOutboxPersistedState = {
    version: CLOUD_GROUP_OUTBOX_VERSION,
    entries: [],
    completedCanonicalMessageIds: [],
  };
  private committedState = cloneState(this.state);

  private restored = false;
  private restorePromise: Promise<CloudGroupOutboxEntry[]> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly pendingMutations: CloudGroupOutboxStateMutation[] = [];
  private readonly enqueueInFlight = new Map<string, Promise<CloudGroupOutboxEntry | null>>();
  private readonly inFlight = new Map<string, Promise<CloudGroupOutboxEntry | null>>();
  private readonly acknowledgementInFlight = new Map<string, Promise<boolean>>();
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly accountId: string,
    private readonly persistence: CloudGroupOutboxPersistence,
  ) {}

  async restore() {
    if (this.restored) return this.entries();
    if (this.restorePromise) return this.restorePromise;
    this.restorePromise = (async () => {
      const restoredState = normalizeState(await this.persistence.load());
      this.committedState = cloneState(restoredState);
      this.state = restoredState;
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
    const existingEnqueue = this.enqueueInFlight.get(entry.canonicalMessageId);
    if (existingEnqueue) return existingEnqueue;
    if (this.state.completedCanonicalMessageIds.includes(entry.canonicalMessageId)) return null;
    const existing = this.state.entries.find((candidate) => candidate.canonicalMessageId === entry.canonicalMessageId);
    if (existing) return cloneEntry(existing);
    const enqueue = this.commitMutation((state) => {
      if (state.completedCanonicalMessageIds.includes(entry.canonicalMessageId)) return null;
      const persisted = state.entries.find((candidate) => candidate.canonicalMessageId === entry.canonicalMessageId);
      if (persisted) return cloneEntry(persisted);
      const queued = cloneEntry(entry);
      state.entries.push(queued);
      return cloneEntry(queued);
    });
    this.enqueueInFlight.set(entry.canonicalMessageId, enqueue);
    try {
      return await enqueue;
    } finally {
      this.enqueueInFlight.delete(entry.canonicalMessageId);
    }
  }

  async requeueFailed(value: CloudGroupOutboxEntry) {
    await this.ensureRestored();
    const entry = normalizeEntry(value);
    if (!entry) throw new Error('Cloud group outbox entry is invalid.');
    const existingEnqueue = this.enqueueInFlight.get(entry.canonicalMessageId);
    if (existingEnqueue) await existingEnqueue;
    if (this.state.completedCanonicalMessageIds.includes(entry.canonicalMessageId)) return null;

    const requeue = this.commitMutation((state) => {
      if (state.completedCanonicalMessageIds.includes(entry.canonicalMessageId)) return null;
      const existingIndex = state.entries.findIndex((candidate) => (
        candidate.canonicalMessageId === entry.canonicalMessageId
      ));
      if (existingIndex < 0) {
        const queued = cloneEntry(entry);
        state.entries.push(queued);
        return cloneEntry(queued);
      }

      const existing = state.entries[existingIndex]!;
      const retryRecipientIds = uniqueText([
        ...entry.pendingRecipientIds,
        ...entry.deliveredRecipientIds,
        ...(entry.exhaustedRecipientIds ?? []),
      ]);
      const retryRecipientSet = new Set(retryRecipientIds);
      const deliveredRecipientIds = existing.deliveredRecipientIds.filter((recipientId) => (
        retryRecipientSet.has(recipientId)
      ));
      const deliveredRecipientSet = new Set(deliveredRecipientIds);
      const pendingRecipientIds = retryRecipientIds.filter((recipientId) => (
        !deliveredRecipientSet.has(recipientId)
      ));
      const attemptsByRecipientId = Object.fromEntries(
        pendingRecipientIds.map((recipientId) => [recipientId, 0]),
      );
      const queued: CloudGroupOutboxEntry = {
        ...entry,
        payloadVersion: Math.max(existing.payloadVersion ?? 0, entry.payloadVersion ?? 0) + 1,
        deliveryGeneration: Math.max(existing.deliveryGeneration ?? 0, entry.deliveryGeneration ?? 0) + 1,
        awaitingCanonicalAck: false,
        pendingRecipientIds,
        deliveredRecipientIds,
        exhaustedRecipientIds: undefined,
        attemptsByRecipientId,
        nextAttemptAtMs: 0,
      };
      state.entries[existingIndex] = queued;
      return cloneEntry(queued);
    });
    this.enqueueInFlight.set(entry.canonicalMessageId, requeue);
    try {
      const queued = await requeue;
      if (queued) this.notify();
      return queued;
    } finally {
      this.enqueueInFlight.delete(entry.canonicalMessageId);
    }
  }

  async completeAttachmentUpload(
    canonicalMessageId: string,
    payload: { envelope: string; attachments: SendCloudMessageAttachmentInput[] },
  ) {
    await this.ensureRestored();
    const normalizedId = canonicalMessageId.trim();
    const envelope = payload.envelope.trim();
    const attachments = normalizedCloudGroupOutboxAttachments(payload.attachments);
    if (!normalizedId || !envelope || !attachments) {
      throw new Error('Cloud group outbox attachment payload is invalid.');
    }
    const pendingEnqueue = this.enqueueInFlight.get(normalizedId);
    if (pendingEnqueue) await pendingEnqueue;

    const update = this.commitMutation((state) => {
      const index = state.entries.findIndex((entry) => entry.canonicalMessageId === normalizedId);
      if (index < 0) return null;
      const current = state.entries[index]!;
      const next = normalizeEntry({
        ...current,
        envelope,
        attachments,
        pendingAttachments: undefined,
        payloadVersion: (current.payloadVersion ?? 0) + 1,
      });
      if (!next) throw new Error('Cloud group outbox attachment payload is invalid.');
      state.entries[index] = next;
      return cloneEntry(next);
    });
    const updated = await update;
    if (updated) this.notify();
    return updated;
  }

  async deliver(
    canonicalMessageId: string,
    send: CloudGroupOutboxSend,
    options: { nowMs?: number; force?: boolean } = {},
  ): Promise<CloudGroupOutboxEntry | null> {
    await this.ensureRestored();
    const normalizedId = canonicalMessageId.trim();
    if (!normalizedId) return null;
    const pendingEnqueue = this.enqueueInFlight.get(normalizedId);
    if (pendingEnqueue) await pendingEnqueue;
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
      .filter((entry) => (
        entry.awaitingCanonicalAck === true
        || (entry.pendingRecipientIds.length > 0 && entry.nextAttemptAtMs <= nowMs)
      ))
      .map((entry) => entry.canonicalMessageId);
    return Promise.all(dueIds.map((id) => this.deliver(id, send, { nowMs })));
  }

  async acknowledgeCanonicalDelivery(canonicalMessageId: string) {
    await this.ensureRestored();
    const normalizedId = canonicalMessageId.trim();
    if (!normalizedId) return false;
    const existingAcknowledgement = this.acknowledgementInFlight.get(normalizedId);
    if (existingAcknowledgement) return existingAcknowledgement;
    const acknowledgement = this.acknowledgeCanonicalDeliveryOnce(normalizedId);
    this.acknowledgementInFlight.set(normalizedId, acknowledgement);
    try {
      return await acknowledgement;
    } finally {
      this.acknowledgementInFlight.delete(normalizedId);
    }
  }

  private async acknowledgeCanonicalDeliveryOnce(normalizedId: string) {
    if (this.state.completedCanonicalMessageIds.includes(normalizedId)) return true;
    const entry = this.state.entries.find((candidate) => candidate.canonicalMessageId === normalizedId);
    if (
      !entry
      || entry.awaitingCanonicalAck !== true
      || entry.pendingRecipientIds.length > 0
      || (entry.exhaustedRecipientIds?.length ?? 0) > 0
      || entry.deliveredRecipientIds.length === 0
    ) {
      return false;
    }

    const acknowledged = await this.commitMutation((state) => {
      if (state.completedCanonicalMessageIds.includes(normalizedId)) return true;
      const persistedEntry = state.entries.find((candidate) => candidate.canonicalMessageId === normalizedId);
      if (
        !persistedEntry
        || persistedEntry.awaitingCanonicalAck !== true
        || persistedEntry.pendingRecipientIds.length > 0
        || (persistedEntry.exhaustedRecipientIds?.length ?? 0) > 0
        || persistedEntry.deliveredRecipientIds.length === 0
      ) {
        return false;
      }
      state.entries = state.entries.filter((candidate) => candidate.canonicalMessageId !== normalizedId);
      state.completedCanonicalMessageIds = [
        ...state.completedCanonicalMessageIds.filter((id) => id !== normalizedId),
        normalizedId,
      ].slice(-MAX_COMPLETED_MESSAGE_IDS);
      return true;
    });
    if (acknowledged) this.notify();
    return acknowledged;
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
    const outcome = await this.commitMutation((state) => {
      const persistedEntry = state.entries.find((candidate) => candidate.canonicalMessageId === canonicalMessageId);
      if (!persistedEntry) return null;
      const delivered = new Set(persistedEntry.deliveredRecipientIds);
      const exhausted = new Set(persistedEntry.exhaustedRecipientIds ?? []);
      const pending = new Set(persistedEntry.pendingRecipientIds);

      outcomes.forEach((recipientOutcome, index) => {
        const recipientId = pendingAtStart[index];
        if (!recipientId) return;
        if (recipientOutcome.status === 'fulfilled') {
          pending.delete(recipientId);
          exhausted.delete(recipientId);
          delivered.add(recipientId);
          return;
        }
        const attempts = (persistedEntry.attemptsByRecipientId[recipientId] ?? 0) + 1;
        persistedEntry.attemptsByRecipientId[recipientId] = attempts;
        if (attempts >= CLOUD_GROUP_OUTBOX_MAX_ATTEMPTS) {
          pending.delete(recipientId);
          exhausted.add(recipientId);
        }
      });

      persistedEntry.pendingRecipientIds = [...pending];
      persistedEntry.deliveredRecipientIds = [...delivered];
      persistedEntry.exhaustedRecipientIds = exhausted.size > 0 ? [...exhausted] : undefined;
      persistedEntry.awaitingCanonicalAck = persistedEntry.pendingRecipientIds.length === 0
        && delivered.size > 0
        && exhausted.size === 0;
      const retryDelays = persistedEntry.pendingRecipientIds.map((recipientId) => {
        const attempts = Math.max(1, persistedEntry.attemptsByRecipientId[recipientId] ?? 1);
        return CLOUD_GROUP_OUTBOX_RETRY_DELAYS_MS[
          Math.min(attempts - 1, CLOUD_GROUP_OUTBOX_RETRY_DELAYS_MS.length - 1)
        ];
      });
      persistedEntry.nextAttemptAtMs = retryDelays.length > 0 ? nowMs + Math.min(...retryDelays) : 0;
      return cloneEntry(persistedEntry);
    });
    if (outcome) this.notify();
    return outcome;
  }

  private async ensureRestored() {
    if (!this.restored) await this.restore();
  }

  private commitMutation<T>(apply: (state: CloudGroupOutboxPersistedState) => T) {
    const mutation: CloudGroupOutboxStateMutation = { apply };
    const optimisticState = cloneState(this.state);
    apply(optimisticState);
    this.state = optimisticState;
    this.pendingMutations.push(mutation);

    const execution = this.mutationTail.then(async () => {
      const nextCommittedState = cloneState(this.committedState);
      const result = apply(nextCommittedState);
      await this.persistence.save(cloneState(nextCommittedState));
      this.committedState = nextCommittedState;
      return result;
    });
    const settled = execution.then(
      (result) => {
        this.settleMutation(mutation);
        return result;
      },
      (error: unknown) => {
        this.settleMutation(mutation);
        throw error;
      },
    );
    this.mutationTail = settled.then(() => {}, () => {});
    return settled;
  }

  private settleMutation(mutation: CloudGroupOutboxStateMutation) {
    const index = this.pendingMutations.indexOf(mutation);
    if (index >= 0) this.pendingMutations.splice(index, 1);
    const rebasedState = cloneState(this.committedState);
    this.pendingMutations.forEach((pending) => pending.apply(rebasedState));
    this.state = rebasedState;
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
    let indexedDbState: CloudGroupOutboxPersistedState | null = null;
    if (this.factory) {
      try {
        const value = await this.request('readonly', (store) => store.get(this.accountId));
        if (value !== undefined) indexedDbState = normalizeState(value);
      } catch {
        // Reconcile with localStorage when IndexedDB is temporarily unavailable.
      }
    }
    let fallbackState: CloudGroupOutboxPersistedState | null = null;
    try {
      const raw = this.storage?.getItem(`${CLOUD_GROUP_OUTBOX_LOCAL_STORAGE_PREFIX}${this.accountId}`);
      fallbackState = raw ? normalizeState(JSON.parse(raw)) : null;
    } catch {
      fallbackState = null;
    }
    const state = indexedDbState && fallbackState
      ? mergeStates(indexedDbState, fallbackState)
      : fallbackState ?? indexedDbState;
    if (!state) return null;

    if (fallbackState && this.factory) {
      try {
        await this.request('readwrite', (store) => store.put(state, this.accountId));
        this.removeFallback();
      } catch {
        // Retain the fallback until the reconciled snapshot reaches IndexedDB.
      }
    }
    return state;
  }

  async save(value: CloudGroupOutboxPersistedState) {
    if (this.factory) {
      try {
        await this.request('readwrite', (store) => store.put(value, this.accountId));
        this.removeFallback();
        return;
      } catch {
        // Preserve the outbox in localStorage so a transient IDB failure does
        // not silently turn a queued send into a memory-only operation.
      }
    }
    try {
      if (!this.storage) throw new Error('localStorage is unavailable.');
      this.storage.setItem(
        `${CLOUD_GROUP_OUTBOX_LOCAL_STORAGE_PREFIX}${this.accountId}`,
        JSON.stringify(value),
      );
    } catch {
      throw new Error('Unable to persist the Cloud group outbox to IndexedDB or localStorage.');
    }
  }

  private removeFallback() {
    try {
      this.storage?.removeItem(`${CLOUD_GROUP_OUTBOX_LOCAL_STORAGE_PREFIX}${this.accountId}`);
    } catch {
      // A successful IndexedDB transaction remains the durable source of truth.
    }
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
