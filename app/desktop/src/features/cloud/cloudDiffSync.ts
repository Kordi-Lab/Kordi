import type {
  CloudMessage,
  CloudSessionFork,
  CloudSyncEvent as AuthCloudSyncEvent,
  CloudSyncResponse,
} from './authClient';

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

/** Fork lineage seen by the local account, keyed by source (parent)
 * session id. Each entry is the list of forks that have been
 * registered against that source — ordered by createdAt so the
 * sidebar / chip popovers render newest-first if they choose. */
export type CloudForkLineageByParentSessionId = Record<string, CloudSessionFork[]>;

function normalizeCloudSessionFork(value: unknown): CloudSessionFork | null {
  const record = objectRecord(value);
  if (!record) return null;
  const forkSessionId = cleanText(record.forkSessionId);
  const parentSessionId = cleanText(record.parentSessionId);
  const createdByAccountId = cleanText(record.createdByAccountId);
  const createdAt = cleanText(record.createdAt);
  if (!forkSessionId || !parentSessionId || !createdByAccountId || !createdAt) return null;
  const parentMessageId = typeof record.parentMessageId === 'string' && record.parentMessageId.trim().length > 0
    ? record.parentMessageId.trim()
    : null;
  return { forkSessionId, parentSessionId, parentMessageId, createdByAccountId, createdAt };
}

function payloadFork(event: CloudSyncEvent): CloudSessionFork | null {
  // The server publishes `session-forked` with payload =
  // CloudSessionForkSummary directly (no envelope object).
  return normalizeCloudSessionFork(event.payload);
}

function upsertFork(forks: CloudSessionFork[], next: CloudSessionFork): CloudSessionFork[] {
  const index = forks.findIndex((fork) => fork.forkSessionId === next.forkSessionId);
  const merged = index >= 0
    ? [...forks.slice(0, index), { ...forks[index], ...next }, ...forks.slice(index + 1)]
    : [...forks, next];
  return merged.sort((left, right) => (
    left.createdAt.localeCompare(right.createdAt)
    || left.forkSessionId.localeCompare(right.forkSessionId)
  ));
}

export function applyCloudSyncEventsToForkLineage(
  currentLineage: CloudForkLineageByParentSessionId,
  events: CloudSyncEvent[],
): CloudForkLineageByParentSessionId {
  let next = currentLineage;
  for (const event of events) {
    if (event.eventType !== 'session-forked') continue;
    const fork = payloadFork(event);
    if (!fork) continue;
    next = {
      ...next,
      [fork.parentSessionId]: upsertFork(next[fork.parentSessionId] ?? [], fork),
    };
  }
  return next;
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

export type SyncCloudDiffOnceInput = {
  accountId: string;
  messagesByPeer: Record<string, CloudMessage[]>;
  /** Fork lineage observed so far. Optional for backward compatibility
   * with callers that don't yet track lineage state. */
  forkLineageByParentSessionId?: CloudForkLineageByParentSessionId;
  cursorStorage?: Storage | null;
  fetchEvents(cursor: string): Promise<CloudSyncResponse>;
};

export type SyncCloudDiffOnceResult = {
  messagesByPeer: Record<string, CloudMessage[]>;
  forkLineageByParentSessionId: CloudForkLineageByParentSessionId;
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
  const previousLineage = input.forkLineageByParentSessionId ?? {};
  let response: CloudSyncResponse;
  try {
    response = await input.fetchEvents(previousCursor);
  } catch {
    return {
      messagesByPeer: input.messagesByPeer,
      forkLineageByParentSessionId: previousLineage,
      cursor: previousCursor,
      fallbackRequired: true,
      hasMore: false,
    };
  }

  const nextCursor = normalizeCursor(response.cursor);
  if (cursorWentBackwards(previousCursor, nextCursor)) {
    return {
      messagesByPeer: input.messagesByPeer,
      forkLineageByParentSessionId: previousLineage,
      cursor: previousCursor,
      fallbackRequired: true,
      hasMore: false,
    };
  }

  const events = response.events ?? [];
  const messagesByPeer = applyCloudSyncEventsToMessagesByPeer(
    input.accountId,
    input.messagesByPeer,
    events,
  );
  const forkLineageByParentSessionId = applyCloudSyncEventsToForkLineage(previousLineage, events);
  saveCloudSyncCursor(input.accountId, nextCursor, storage);
  return {
    messagesByPeer,
    forkLineageByParentSessionId,
    cursor: nextCursor,
    fallbackRequired: false,
    hasMore: Boolean(response.hasMore),
  };
}
