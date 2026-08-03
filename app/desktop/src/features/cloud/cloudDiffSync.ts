import type { CloudArtifactActivity, CloudMessage, CloudSessionForkSummary, CloudSessionPin, CloudSessionTitle, CloudSyncEvent as AuthCloudSyncEvent, CloudSyncResponse, CloudTaskActivity } from './authClient';
import { applyCloudAgentSyncEvents, type CloudAgentDefinition } from './cloudAgents';
import { cloudMessageMetadataOnly } from './cloudMessageCache';
import {
  latestCloudReceiptAt,
  upsertCloudMessage as upsertMessage,
} from './cloudMessageMerge';
import { EMPTY_CLOUD_SESSION_ACTIVITY, mergeCloudSessionActivity, normalizeCloudSessionActivitySnapshot, type CloudSessionActivityStore } from './cloudSessionActivity';

export {
  cloudMessageAttachmentsEqual,
  cloudMessagesEqual,
  mergeCloudMessageMonotonicState,
} from './cloudMessageMerge';

export type CloudSyncEvent = AuthCloudSyncEvent;

export const CLOUD_SYNC_CURSOR_PREFIX = 'kordi.cloud.syncCursor.v1:';
export const CLOUD_SESSION_VISIBILITY_PREFIX = 'kordi.cloud.sessionVisibility.v1:';

export type CloudSessionVisibilityState = {
  hiddenSessionIds: Set<string>;
  deletedSessionIds: Set<string>;
};

export type CloudSessionPinsById = Record<string, CloudSessionPin>;
export type CloudSessionTitlesById = Record<string, CloudSessionTitle>;

export function cloudSyncCursorStorageKey(accountId: string): string {
  return `${CLOUD_SYNC_CURSOR_PREFIX}${accountId.trim()}`;
}

export function cloudSessionVisibilityStorageKey(accountId: string): string {
  return `${CLOUD_SESSION_VISIBILITY_PREFIX}${accountId.trim()}`;
}

function browserLocalStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function normalizeCursor(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? '';
  if (!/^\d+$/.test(trimmed)) return '0';
  return trimmed;
}

export function loadCloudSyncCursor(accountId: string | null | undefined, storage: Storage | null = browserLocalStorage()): string {
  const trimmedAccountId = accountId?.trim() ?? '';
  if (!trimmedAccountId || !storage) return '0';
  try {
    return normalizeCursor(storage.getItem(cloudSyncCursorStorageKey(trimmedAccountId)));
  } catch {
    return '0';
  }
}

export function saveCloudSyncCursor(accountId: string | null | undefined, cursor: string, storage: Storage | null = browserLocalStorage()): void {
  const trimmedAccountId = accountId?.trim() ?? '';
  const normalizedCursor = normalizeCursor(cursor);
  if (!trimmedAccountId || !storage) return;
  try {
    storage.setItem(cloudSyncCursorStorageKey(trimmedAccountId), normalizedCursor);
  } catch {
    // Best effort. A failed cursor write only causes a future duplicate sync;
    // event application is idempotent by message id.
  }
}

function normalizeSessionIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(cleanText).filter(Boolean))];
}

export function loadCloudSessionVisibility(
  accountId: string | null | undefined,
  storage: Storage | null = browserLocalStorage(),
): CloudSessionVisibilityState {
  const trimmedAccountId = accountId?.trim() ?? '';
  if (!trimmedAccountId || !storage) return { hiddenSessionIds: new Set(), deletedSessionIds: new Set() };
  try {
    const parsed = objectRecord(JSON.parse(storage.getItem(cloudSessionVisibilityStorageKey(trimmedAccountId)) ?? '{}'));
    return {
      hiddenSessionIds: new Set(normalizeSessionIdList(parsed?.hiddenSessionIds)),
      deletedSessionIds: new Set(normalizeSessionIdList(parsed?.deletedSessionIds)),
    };
  } catch {
    return { hiddenSessionIds: new Set(), deletedSessionIds: new Set() };
  }
}

export function saveCloudSessionVisibility(
  accountId: string | null | undefined,
  visibility: CloudSessionVisibilityState,
  storage: Storage | null = browserLocalStorage(),
): void {
  const trimmedAccountId = accountId?.trim() ?? '';
  if (!trimmedAccountId || !storage) return;
  try {
    storage.setItem(cloudSessionVisibilityStorageKey(trimmedAccountId), JSON.stringify({
      hiddenSessionIds: [...visibility.hiddenSessionIds].map((value) => value.trim()).filter(Boolean),
      deletedSessionIds: [...visibility.deletedSessionIds].map((value) => value.trim()).filter(Boolean),
    }));
  } catch {
    // Best effort. Server visibility is still authoritative on next refresh.
  }
}

function normalizeCloudMessage(value: unknown): CloudMessage | null {
  const record = objectRecord(value);
  if (!record) return null;
  const messageId = cleanText(record.messageId);
  const fromAccountId = cleanText(record.fromAccountId);
  const toAccountId = cleanText(record.toAccountId);
  const createdAt = cleanText(record.createdAt);
  if (!messageId || !fromAccountId || !toAccountId || !createdAt) return null;
  const direction = record.direction === 'outgoing' ? 'outgoing' : 'incoming';
  const attachments = Array.isArray(record.attachments) ? record.attachments as CloudMessage['attachments'] : undefined;
  return cloudMessageMetadataOnly({
    messageId,
    fromAccountId,
    toAccountId,
    body: typeof record.body === 'string' ? record.body : '',
    createdAt,
    deliveredAt: typeof record.deliveredAt === 'string' ? record.deliveredAt : null,
    readAt: typeof record.readAt === 'string' ? record.readAt : null,
    direction,
    ...(typeof record.sessionId === 'string' ? { sessionId: record.sessionId } : {}),
    ...(attachments ? { attachments } : {}),
  });
}

function messagePeerId(accountId: string, message: CloudMessage, eventPeerId?: string | null): string | null {
  const eventPeer = eventPeerId?.trim() ?? '';
  if (eventPeer) return eventPeer;
  if (message.fromAccountId === accountId) return message.toAccountId;
  if (message.toAccountId === accountId) return message.fromAccountId;
  return null;
}

function payloadMessage(event: CloudSyncEvent): CloudMessage | null {
  const payload = objectRecord(event.payload);
  return normalizeCloudMessage(payload?.message);
}

function eventSessionId(event: CloudSyncEvent): string {
  const payload = objectRecord(event.payload);
  return cleanText(payload?.sessionId) || cleanText(event.peerAccountId);
}

function directPersonSessionId(accountId: string, peerId: string): string {
  return `session:direct-person:${[accountId.trim(), peerId.trim()].filter(Boolean).sort().join(':')}`;
}

function messageSessionKeys(accountId: string, message: CloudMessage, eventPeerId?: string | null): string[] {
  const keys = new Set<string>();
  const sessionId = cleanText(message.sessionId);
  if (sessionId) keys.add(sessionId);
  const peerId = messagePeerId(accountId, message, eventPeerId);
  if (peerId) {
    keys.add(peerId);
    keys.add(directPersonSessionId(accountId, peerId));
  }
  return [...keys];
}

function messageMatchesSession(accountId: string, message: CloudMessage, sessionId: string, peerId?: string | null): boolean {
  return messageSessionKeys(accountId, message, peerId).includes(sessionId);
}

export function removeCloudSessionMessages(
  accountId: string,
  currentMessagesByPeer: Record<string, CloudMessage[]>,
  sessionId: string,
): Record<string, CloudMessage[]> {
  const trimmedSessionId = sessionId.trim();
  if (!trimmedSessionId) return currentMessagesByPeer;
  const next: Record<string, CloudMessage[]> = {};
  let changed = false;
  for (const [peerId, messages] of Object.entries(currentMessagesByPeer)) {
    const retained = messages.filter((message) => !messageMatchesSession(accountId, message, trimmedSessionId, peerId));
    if (retained.length !== messages.length) changed = true;
    if (retained.length > 0) next[peerId] = retained.length === messages.length ? messages : retained;
  }
  return changed ? next : currentMessagesByPeer;
}

function readReceiptPayload(event: CloudSyncEvent): { messageIds: string[]; readAt: string } | null {
  const payload = objectRecord(event.payload);
  if (!payload) return null;
  const readAt = cleanText(payload.readAt);
  const messageIds = Array.isArray(payload.messageIds)
    ? payload.messageIds.map(cleanText).filter(Boolean)
    : [];
  if (!readAt || messageIds.length === 0) return null;
  return { messageIds, readAt };
}

export function applyCloudSyncEventsToMessagesByPeer(
  accountId: string,
  currentMessagesByPeer: Record<string, CloudMessage[]>,
  events: CloudSyncEvent[],
  initialHiddenSessionIds: ReadonlySet<string> = new Set(),
  initialDeletedSessionIds: ReadonlySet<string> = new Set(),
): Record<string, CloudMessage[]> {
  let next = currentMessagesByPeer;
  const hiddenSessionIds = new Set(initialHiddenSessionIds);
  const deletedSessionIds = new Set(initialDeletedSessionIds);
  for (const event of events) {
    if (event.eventType === 'session.hidden') {
      const sessionId = eventSessionId(event);
      if (sessionId && !deletedSessionIds.has(sessionId)) hiddenSessionIds.add(sessionId);
      continue;
    }

    if (event.eventType === 'session.unhidden') {
      const sessionId = eventSessionId(event);
      if (sessionId) hiddenSessionIds.delete(sessionId);
      continue;
    }

    if (event.eventType === 'session.deleted') {
      const sessionId = eventSessionId(event);
      if (!sessionId) continue;
      hiddenSessionIds.delete(sessionId);
      deletedSessionIds.add(sessionId);
      next = removeCloudSessionMessages(accountId, next, sessionId);
      continue;
    }

    if (event.eventType === 'message.upsert') {
      const message = payloadMessage(event);
      if (!message) continue;
      const peerId = messagePeerId(accountId, message, event.peerAccountId);
      if (!peerId) continue;
      const keys = messageSessionKeys(accountId, message, event.peerAccountId);
      for (const key of keys) {
        hiddenSessionIds.delete(key);
        deletedSessionIds.delete(key);
      }
      const currentPeerMessages = next[peerId] ?? [];
      const nextPeerMessages = upsertMessage(currentPeerMessages, message);
      if (nextPeerMessages !== currentPeerMessages) {
        next = {
          ...next,
          [peerId]: nextPeerMessages,
        };
      }
      continue;
    }

    if (event.eventType === 'message.read') {
      const receipt = readReceiptPayload(event);
      const peerId = event.peerAccountId?.trim() ?? '';
      if (!receipt || !peerId || !(peerId in next)) continue;
      const ids = new Set(receipt.messageIds);
      let changed = false;
      const nextPeerMessages = next[peerId].map((message) => {
        if (!ids.has(message.messageId)) return message;
        const deliveredAt = message.deliveredAt ?? receipt.readAt;
        const readAt = latestCloudReceiptAt(message.readAt, receipt.readAt);
        if (message.deliveredAt === deliveredAt && message.readAt === readAt) return message;
        changed = true;
        return { ...message, deliveredAt, readAt };
      });
      if (changed) {
        next = {
          ...next,
          [peerId]: nextPeerMessages,
        };
      }
    }
  }
  return next;
}

export function applyCloudSyncEventsToSessionVisibility(
  accountId: string,
  current: CloudSessionVisibilityState,
  events: CloudSyncEvent[],
): CloudSessionVisibilityState {
  const hiddenSessionIds = new Set(current.hiddenSessionIds);
  const deletedSessionIds = new Set(current.deletedSessionIds);
  for (const event of events) {
    if (event.eventType === 'message.upsert') {
      const message = payloadMessage(event);
      if (!message) continue;
      for (const key of messageSessionKeys(accountId, message, event.peerAccountId)) {
        hiddenSessionIds.delete(key);
        deletedSessionIds.delete(key);
      }
      continue;
    }

    const sessionId = eventSessionId(event);
    if (!sessionId) continue;
    if (event.eventType === 'session.hidden') {
      if (!deletedSessionIds.has(sessionId)) hiddenSessionIds.add(sessionId);
      continue;
    }
    if (event.eventType === 'session.unhidden') {
      hiddenSessionIds.delete(sessionId);
      continue;
    }
    if (event.eventType === 'session.deleted') {
      hiddenSessionIds.delete(sessionId);
      deletedSessionIds.add(sessionId);
    }
  }
  return { hiddenSessionIds, deletedSessionIds };
}

export function applyCloudSyncEventsToSessionForks(
  current: Record<string, CloudSessionForkSummary>,
  events: CloudSyncEvent[],
): Record<string, CloudSessionForkSummary> {
  let next = current;
  for (const event of events) {
    if (event.eventType !== 'session-forked') continue;
    const payload = objectRecord(event.payload);
    if (!payload) continue;
    const forkSessionId = cleanText(payload.forkSessionId);
    const parentSessionId = cleanText(payload.parentSessionId);
    const createdByAccountId = cleanText(payload.createdByAccountId);
    const createdAt = cleanText(payload.createdAt) || event.occurredAt;
    if (!forkSessionId || !parentSessionId || !createdByAccountId || !createdAt) continue;
    next = {
      ...next,
      [forkSessionId]: {
        forkSessionId,
        parentSessionId,
        parentMessageId: cleanText(payload.parentMessageId) || null,
        createdByAccountId,
        createdAt,
      },
    };
  }
  return next;
}

function normalizeCloudSessionPin(value: unknown, existing?: CloudSessionPin | null): CloudSessionPin | null {
  const record = objectRecord(value);
  if (!record) return null;
  const sessionId = cleanText(record.sessionId);
  if (!sessionId) return null;
  const scope = cleanText(record.scope).toLowerCase();
  const hasMessageId = Object.prototype.hasOwnProperty.call(record, 'messageId');
  const messageId = hasMessageId ? cleanText(record.messageId) || null : undefined;
  const sharedMessageId = scope === 'shared'
    ? messageId ?? null
    : cleanText(record.sharedMessageId) || existing?.sharedMessageId || null;
  const privateMessageId = scope === 'private'
    ? messageId ?? null
    : cleanText(record.privateMessageId) || existing?.privateMessageId || null;
  return {
    sessionId,
    sharedMessageId,
    privateMessageId,
    effectiveMessageId: privateMessageId || sharedMessageId || null,
    updatedAt: cleanText(record.updatedAt) || null,
  };
}

export function applyCloudSyncEventsToSessionPins(
  current: CloudSessionPinsById,
  events: CloudSyncEvent[],
): CloudSessionPinsById {
  let next = current;
  for (const event of events) {
    if (event.eventType !== 'session.pin.updated') continue;
    const payload = objectRecord(event.payload);
    const sessionId = cleanText(payload?.sessionId) || cleanText(event.peerAccountId);
    if (!sessionId) continue;
    const pin = normalizeCloudSessionPin({ ...payload, sessionId }, next[sessionId]);
    if (!pin) continue;
    next = { ...next, [sessionId]: pin };
  }
  return next;
}

function normalizeCloudSessionTitle(value: unknown): CloudSessionTitle | null {
  const record = objectRecord(value);
  if (!record) return null;
  const sessionId = cleanText(record.sessionId);
  const title = cleanText(record.title);
  const titleSource = cleanText(record.titleSource).toLowerCase();
  if (!sessionId || !title || !['placeholder', 'auto', 'imported', 'external', 'legacy', 'manual'].includes(titleSource)) return null;
  const titleRevision = typeof record.titleRevision === 'number' ? record.titleRevision : Number(record.titleRevision);
  const titlePolicyVersion = typeof record.titlePolicyVersion === 'number' ? record.titlePolicyVersion : Number(record.titlePolicyVersion);
  const updatedAtMs = typeof record.updatedAtMs === 'number' ? record.updatedAtMs : Number(record.updatedAtMs);
  if (![titleRevision, titlePolicyVersion, updatedAtMs].every(Number.isFinite)) return null;
  return {
    sessionId,
    title,
    titleSource: titleSource as CloudSessionTitle['titleSource'],
    titleRevision,
    titlePolicyVersion,
    titleGeneratedFromMessageId: cleanText(record.titleGeneratedFromMessageId) || null,
    updatedAtMs,
    updatedByAccountId: cleanText(record.updatedByAccountId),
    updatedAt: cleanText(record.updatedAt),
  };
}

export function applyCloudSyncEventsToSessionTitles(
  current: CloudSessionTitlesById,
  events: CloudSyncEvent[],
): CloudSessionTitlesById {
  let next = current;
  for (const event of events) {
    if (event.eventType !== 'session.title.updated') continue;
    const payload = objectRecord(event.payload);
    const sessionTitle = normalizeCloudSessionTitle(payload?.sessionTitle);
    if (!sessionTitle) continue;
    next = { ...next, [sessionTitle.sessionId]: sessionTitle };
  }
  return next;
}

export function applyCloudSyncEventsToSessionActivity(
  current: CloudSessionActivityStore,
  events: CloudSyncEvent[],
): CloudSessionActivityStore {
  let next = current;
  for (const event of events) {
    const payload = objectRecord(event.payload);
    if (!payload) continue;
    if (event.eventType === 'task.upsert') {
      const task = payload.task;
      next = mergeCloudSessionActivity(
        next,
        normalizeCloudSessionActivitySnapshot({ tasks: task ? [task as CloudTaskActivity] : [], artifacts: [] }),
      );
      continue;
    }
    if (event.eventType === 'artifact.upsert' || event.eventType === 'artifact.archived') {
      const artifact = payload.artifact;
      next = mergeCloudSessionActivity(
        next,
        normalizeCloudSessionActivitySnapshot({ tasks: [], artifacts: artifact ? [artifact as CloudArtifactActivity] : [] }),
      );
    }
  }
  return next;
}

export type SyncCloudDiffOnceInput = {
  accountId: string;
  messagesByPeer: Record<string, CloudMessage[]>;
  sessionActivity?: CloudSessionActivityStore;
  sessionForksById?: Record<string, CloudSessionForkSummary>;
  sessionPinsById?: CloudSessionPinsById;
  sessionTitlesById?: CloudSessionTitlesById;
  cloudAgentsById?: Record<string, CloudAgentDefinition>;
  hiddenSessionIds?: ReadonlySet<string>;
  deletedSessionIds?: ReadonlySet<string>;
  cursorStorage?: Storage | null;
  shouldSaveCursor?: () => boolean;
  fetchEvents(cursor: string): Promise<CloudSyncResponse>;
};

export type SyncCloudDiffOnceResult = {
  messagesByPeer: Record<string, CloudMessage[]>;
  sessionActivity: CloudSessionActivityStore;
  sessionForksById: Record<string, CloudSessionForkSummary>;
  sessionPinsById: CloudSessionPinsById;
  sessionTitlesById: CloudSessionTitlesById;
  cloudAgentsById: Record<string, CloudAgentDefinition>;
  hiddenSessionIds: Set<string>;
  deletedSessionIds: Set<string>;
  cursor: string;
  fallbackRequired: boolean;
  hasMore: boolean;
};

function cursorWentBackwards(previous: string, next: string): boolean {
  try {
    return BigInt(next) < BigInt(previous);
  } catch {
    return true;
  }
}

export async function syncCloudDiffOnce(input: SyncCloudDiffOnceInput): Promise<SyncCloudDiffOnceResult> {
  const storage = input.cursorStorage ?? browserLocalStorage();
  const previousCursor = loadCloudSyncCursor(input.accountId, storage);
  let response: CloudSyncResponse;
  const initialHiddenSessionIds = new Set(input.hiddenSessionIds ?? []);
  const initialDeletedSessionIds = new Set(input.deletedSessionIds ?? []);
  try {
    response = await input.fetchEvents(previousCursor);
  } catch {
    return { messagesByPeer: input.messagesByPeer, sessionActivity: input.sessionActivity ?? EMPTY_CLOUD_SESSION_ACTIVITY, sessionForksById: input.sessionForksById ?? {}, sessionPinsById: input.sessionPinsById ?? {}, sessionTitlesById: input.sessionTitlesById ?? {}, cloudAgentsById: input.cloudAgentsById ?? {}, hiddenSessionIds: initialHiddenSessionIds, deletedSessionIds: initialDeletedSessionIds, cursor: previousCursor, fallbackRequired: true, hasMore: false };
  }

  const nextCursor = normalizeCursor(response.cursor);
  if (cursorWentBackwards(previousCursor, nextCursor)) {
    return { messagesByPeer: input.messagesByPeer, sessionActivity: input.sessionActivity ?? EMPTY_CLOUD_SESSION_ACTIVITY, sessionForksById: input.sessionForksById ?? {}, sessionPinsById: input.sessionPinsById ?? {}, sessionTitlesById: input.sessionTitlesById ?? {}, cloudAgentsById: input.cloudAgentsById ?? {}, hiddenSessionIds: initialHiddenSessionIds, deletedSessionIds: initialDeletedSessionIds, cursor: previousCursor, fallbackRequired: true, hasMore: false };
  }

  const events = response.events ?? [];
  const visibility = applyCloudSyncEventsToSessionVisibility(input.accountId, {
    hiddenSessionIds: initialHiddenSessionIds,
    deletedSessionIds: initialDeletedSessionIds,
  }, events);
  const messagesByPeer = applyCloudSyncEventsToMessagesByPeer(
    input.accountId,
    input.messagesByPeer,
    events,
    initialHiddenSessionIds,
    initialDeletedSessionIds,
  );
  const sessionActivity = applyCloudSyncEventsToSessionActivity(
    input.sessionActivity ?? EMPTY_CLOUD_SESSION_ACTIVITY,
    events,
  );
  const sessionForksById = applyCloudSyncEventsToSessionForks(input.sessionForksById ?? {}, events);
  const sessionPinsById = applyCloudSyncEventsToSessionPins(input.sessionPinsById ?? {}, events);
  const sessionTitlesById = applyCloudSyncEventsToSessionTitles(input.sessionTitlesById ?? {}, events);
  const cloudAgentsById = applyCloudAgentSyncEvents(input.cloudAgentsById ?? {}, events);
  if (!input.shouldSaveCursor || input.shouldSaveCursor()) {
    saveCloudSyncCursor(input.accountId, nextCursor, storage);
  }
  return { messagesByPeer, sessionActivity, sessionForksById, sessionPinsById, sessionTitlesById, cloudAgentsById, hiddenSessionIds: visibility.hiddenSessionIds, deletedSessionIds: visibility.deletedSessionIds, cursor: nextCursor, fallbackRequired: false, hasMore: Boolean(response.hasMore) };
}
