import type { CloudArtifactActivity, CloudMessage, CloudSyncEvent as AuthCloudSyncEvent, CloudSyncResponse, CloudTaskActivity } from './authClient';
import { EMPTY_CLOUD_SESSION_ACTIVITY, mergeCloudSessionActivity, normalizeCloudSessionActivitySnapshot, type CloudSessionActivityStore } from './cloudSessionActivity';

export type CloudSyncEvent = AuthCloudSyncEvent;

export const CLOUD_SYNC_CURSOR_PREFIX = 'kordi.cloud.syncCursor.v1:';

export function cloudSyncCursorStorageKey(accountId: string): string {
  return `${CLOUD_SYNC_CURSOR_PREFIX}${accountId.trim()}`;
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
  return {
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
  };
}

function messagePeerId(accountId: string, message: CloudMessage, eventPeerId?: string | null): string | null {
  const eventPeer = eventPeerId?.trim() ?? '';
  if (eventPeer) return eventPeer;
  if (message.fromAccountId === accountId) return message.toAccountId;
  if (message.toAccountId === accountId) return message.fromAccountId;
  return null;
}

function upsertMessage(messages: CloudMessage[], nextMessage: CloudMessage): CloudMessage[] {
  const index = messages.findIndex((message) => message.messageId === nextMessage.messageId);
  const merged = index >= 0
    ? [...messages.slice(0, index), { ...messages[index], ...nextMessage }, ...messages.slice(index + 1)]
    : [...messages, nextMessage];
  return merged.sort((left, right) => (
    left.createdAt.localeCompare(right.createdAt)
    || left.messageId.localeCompare(right.messageId)
  ));
}

function payloadMessage(event: CloudSyncEvent): CloudMessage | null {
  const payload = objectRecord(event.payload);
  return normalizeCloudMessage(payload?.message);
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
): Record<string, CloudMessage[]> {
  let next = currentMessagesByPeer;
  for (const event of events) {
    if (event.eventType === 'message.upsert') {
      const message = payloadMessage(event);
      if (!message) continue;
      const peerId = messagePeerId(accountId, message, event.peerAccountId);
      if (!peerId) continue;
      next = {
        ...next,
        [peerId]: upsertMessage(next[peerId] ?? [], message),
      };
      continue;
    }

    if (event.eventType === 'message.read') {
      const receipt = readReceiptPayload(event);
      const peerId = event.peerAccountId?.trim() ?? '';
      if (!receipt || !peerId || !(peerId in next)) continue;
      const ids = new Set(receipt.messageIds);
      next = {
        ...next,
        [peerId]: next[peerId].map((message) => (
          ids.has(message.messageId)
            ? { ...message, deliveredAt: message.deliveredAt ?? receipt.readAt, readAt: receipt.readAt }
            : message
        )),
      };
    }
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
  cursorStorage?: Storage | null;
  fetchEvents(cursor: string): Promise<CloudSyncResponse>;
};

export type SyncCloudDiffOnceResult = {
  messagesByPeer: Record<string, CloudMessage[]>;
  sessionActivity: CloudSessionActivityStore;
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
  try {
    response = await input.fetchEvents(previousCursor);
  } catch {
    return { messagesByPeer: input.messagesByPeer, sessionActivity: input.sessionActivity ?? EMPTY_CLOUD_SESSION_ACTIVITY, cursor: previousCursor, fallbackRequired: true, hasMore: false };
  }

  const nextCursor = normalizeCursor(response.cursor);
  if (cursorWentBackwards(previousCursor, nextCursor)) {
    return { messagesByPeer: input.messagesByPeer, sessionActivity: input.sessionActivity ?? EMPTY_CLOUD_SESSION_ACTIVITY, cursor: previousCursor, fallbackRequired: true, hasMore: false };
  }

  const events = response.events ?? [];
  const messagesByPeer = applyCloudSyncEventsToMessagesByPeer(
    input.accountId,
    input.messagesByPeer,
    events,
  );
  const sessionActivity = applyCloudSyncEventsToSessionActivity(
    input.sessionActivity ?? EMPTY_CLOUD_SESSION_ACTIVITY,
    events,
  );
  saveCloudSyncCursor(input.accountId, nextCursor, storage);
  return { messagesByPeer, sessionActivity, cursor: nextCursor, fallbackRequired: false, hasMore: Boolean(response.hasMore) };
}
