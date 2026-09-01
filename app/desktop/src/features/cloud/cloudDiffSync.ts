import type { CloudArtifactActivity, CloudMessage, CloudSessionForkSummary, CloudSessionPin, CloudSessionTitle, CloudSyncEvent as AuthCloudSyncEvent, CloudSyncResponse, CloudTaskActivity } from './authClient';
import { applyCloudAgentSyncEvents, type CloudAgentDefinition } from './cloudAgents';
import {
  applyCloudSyncEventsToMessagesByPeer,
  cloudSyncEventSessionId,
} from './cloudDiffSyncMessages';
import { EMPTY_CLOUD_SESSION_ACTIVITY, mergeCloudSessionActivity, normalizeCloudSessionActivitySnapshot, type CloudSessionActivityStore } from './cloudSessionActivity';
import { cloudSyncCursorRequiresFallback } from './cloudSyncCursorProgress';

export {
  applyCloudSyncEventsToMessagesByPeer,
  removeCloudSessionMessages,
} from './cloudDiffSyncMessages';

export {
  cloudMessageAttachmentsEqual,
  cloudMessagesEqual,
  mergeCloudMessageMonotonicState,
} from './cloudMessageMerge';

export type CloudSyncEvent = AuthCloudSyncEvent;

export const CLOUD_SYNC_CURSOR_PREFIX = 'kordi.cloud.syncCursor.chat:';
const PREVIOUS_CLOUD_SYNC_CURSOR_PREFIX = 'kordi.cloud.syncCursor.v2:';
export const CLOUD_SESSION_VISIBILITY_PREFIX = 'kordi.cloud.sessionVisibility.v1:';

export type CloudSessionVisibilityState = {
  hiddenSessionIds: Set<string>;
  deletedSessionIds: Set<string>;
  unreadSessionIds: Set<string>;
  pinnedSessionIds: Set<string>;
  mutedSessionIds: Set<string>;
  pinnedGroupSpaceIds: Set<string>;
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
  return trimmed && trimmed.length <= 4096 ? trimmed : '0';
}

export function loadCloudSyncCursor(accountId: string | null | undefined, storage: Storage | null = browserLocalStorage()): string {
  const trimmedAccountId = accountId?.trim() ?? '';
  if (!trimmedAccountId || !storage) return '0';
  try {
    const currentKey = cloudSyncCursorStorageKey(trimmedAccountId);
    const current = storage.getItem(currentKey);
    if (current !== null) return normalizeCursor(current);
    const previousKey = `${PREVIOUS_CLOUD_SYNC_CURSOR_PREFIX}${trimmedAccountId}`;
    const previous = storage.getItem(previousKey);
    if (previous !== null) {
      storage.setItem(currentKey, previous);
      storage.removeItem(previousKey);
    }
    return normalizeCursor(previous);
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
    storage.removeItem(`${PREVIOUS_CLOUD_SYNC_CURSOR_PREFIX}${trimmedAccountId}`);
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
  if (!trimmedAccountId || !storage) return { hiddenSessionIds: new Set(), deletedSessionIds: new Set(), unreadSessionIds: new Set(), pinnedSessionIds: new Set(), mutedSessionIds: new Set(), pinnedGroupSpaceIds: new Set() };
  try {
    const parsed = objectRecord(JSON.parse(storage.getItem(cloudSessionVisibilityStorageKey(trimmedAccountId)) ?? '{}'));
    return {
      hiddenSessionIds: new Set(normalizeSessionIdList(parsed?.hiddenSessionIds)),
      deletedSessionIds: new Set(normalizeSessionIdList(parsed?.deletedSessionIds)),
      unreadSessionIds: new Set(normalizeSessionIdList(parsed?.unreadSessionIds)),
      pinnedSessionIds: new Set(normalizeSessionIdList(parsed?.pinnedSessionIds)),
      mutedSessionIds: new Set(normalizeSessionIdList(parsed?.mutedSessionIds)),
      pinnedGroupSpaceIds: new Set(normalizeSessionIdList(parsed?.pinnedGroupSpaceIds)),
    };
  } catch {
    return { hiddenSessionIds: new Set(), deletedSessionIds: new Set(), unreadSessionIds: new Set(), pinnedSessionIds: new Set(), mutedSessionIds: new Set(), pinnedGroupSpaceIds: new Set() };
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
      unreadSessionIds: [...visibility.unreadSessionIds].map((value) => value.trim()).filter(Boolean),
      pinnedSessionIds: [...visibility.pinnedSessionIds].map((value) => value.trim()).filter(Boolean),
      mutedSessionIds: [...visibility.mutedSessionIds].map((value) => value.trim()).filter(Boolean),
      pinnedGroupSpaceIds: [...visibility.pinnedGroupSpaceIds].map((value) => value.trim()).filter(Boolean),
    }));
  } catch {
    // Best effort. Server visibility is still authoritative on next refresh.
  }
}

export function applyCloudSyncEventsToSessionVisibility(
  _accountId: string,
  current: CloudSessionVisibilityState,
  events: CloudSyncEvent[],
): CloudSessionVisibilityState {
  const hiddenSessionIds = new Set(current.hiddenSessionIds);
  const deletedSessionIds = new Set(current.deletedSessionIds);
  const unreadSessionIds = new Set(current.unreadSessionIds);
  const pinnedSessionIds = new Set(current.pinnedSessionIds);
  const mutedSessionIds = new Set(current.mutedSessionIds);
  const pinnedGroupSpaceIds = new Set(current.pinnedGroupSpaceIds);
  for (const event of events) {
    const sessionId = cloudSyncEventSessionId(event);
    if (!sessionId) continue;
    if (event.eventType === 'session.hidden') {
      if (!deletedSessionIds.has(sessionId)) hiddenSessionIds.add(sessionId);
      pinnedSessionIds.delete(sessionId);
      continue;
    }
    if (event.eventType === 'session.unhidden') {
      hiddenSessionIds.delete(sessionId);
      deletedSessionIds.delete(sessionId);
      continue;
    }
    if (event.eventType === 'session.deleted') {
      hiddenSessionIds.delete(sessionId);
      deletedSessionIds.add(sessionId);
      unreadSessionIds.delete(sessionId);
      pinnedSessionIds.delete(sessionId);
      mutedSessionIds.delete(sessionId);
      continue;
    }
    if (event.eventType === 'session.pinned') pinnedSessionIds.add(sessionId);
    if (event.eventType === 'session.unpinned') pinnedSessionIds.delete(sessionId);
    if (event.eventType === 'session.muted') mutedSessionIds.add(sessionId);
    if (event.eventType === 'session.unmuted') mutedSessionIds.delete(sessionId);
    if (event.eventType === 'session.marked_unread') unreadSessionIds.add(sessionId);
    if (event.eventType === 'session.unmarked_unread') unreadSessionIds.delete(sessionId);
    if (event.eventType === 'group_space.pinned') pinnedGroupSpaceIds.add(sessionId);
    if (event.eventType === 'group_space.unpinned') pinnedGroupSpaceIds.delete(sessionId);
  }
  return { hiddenSessionIds, deletedSessionIds, unreadSessionIds, pinnedSessionIds, mutedSessionIds, pinnedGroupSpaceIds };
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
    const messageId = cleanText(payload?.messageId) || null;
    next = {
      ...next,
      [sessionId]: {
        ...pin,
        lastAction: event.eventId.startsWith('bootstrap:session-pin:')
          ? null
          : {
              kind: messageId ? 'pinned' : 'unpinned',
              scope: cleanText(payload?.scope) === 'shared' ? 'shared' : 'private',
              messageId,
              updatedByAccountId: cleanText(payload?.updatedByAccountId) || null,
              updatedAt: cleanText(payload?.updatedAt) || event.occurredAt || null,
            },
      },
    };
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
    const rawTitle = objectRecord(payload?.sessionTitle);
    const sessionId = cleanText(rawTitle?.sessionId);
    if (sessionId && !cleanText(rawTitle?.title)) {
      if (next[sessionId]) {
        next = { ...next };
        delete next[sessionId];
      }
      continue;
    }
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
  unreadSessionIds?: ReadonlySet<string>;
  pinnedSessionIds?: ReadonlySet<string>;
  mutedSessionIds?: ReadonlySet<string>;
  pinnedGroupSpaceIds?: ReadonlySet<string>;
  cursorStorage?: Storage | null;
  loadCursor?: () => Promise<string>;
  commitResponse?: (response: CloudSyncResponse) => Promise<void>;
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
  unreadSessionIds: Set<string>;
  pinnedSessionIds: Set<string>;
  mutedSessionIds: Set<string>;
  pinnedGroupSpaceIds: Set<string>;
  cursor: string;
  fallbackRequired: boolean;
  hasMore: boolean;
};

export async function syncCloudDiffOnce(input: SyncCloudDiffOnceInput): Promise<SyncCloudDiffOnceResult> {
  const storage = input.cursorStorage ?? browserLocalStorage();
  const previousCursor = input.loadCursor
    ? normalizeCursor(await input.loadCursor())
    : loadCloudSyncCursor(input.accountId, storage);
  let response: CloudSyncResponse;
  const initialHiddenSessionIds = new Set(input.hiddenSessionIds ?? []);
  const initialDeletedSessionIds = new Set(input.deletedSessionIds ?? []);
  const initialUnreadSessionIds = new Set(input.unreadSessionIds ?? []);
  const initialPinnedSessionIds = new Set(input.pinnedSessionIds ?? []);
  const initialMutedSessionIds = new Set(input.mutedSessionIds ?? []);
  const initialPinnedGroupSpaceIds = new Set(input.pinnedGroupSpaceIds ?? []);
  try {
    response = await input.fetchEvents(previousCursor);
  } catch {
    return { messagesByPeer: input.messagesByPeer, sessionActivity: input.sessionActivity ?? EMPTY_CLOUD_SESSION_ACTIVITY, sessionForksById: input.sessionForksById ?? {}, sessionPinsById: input.sessionPinsById ?? {}, sessionTitlesById: input.sessionTitlesById ?? {}, cloudAgentsById: input.cloudAgentsById ?? {}, hiddenSessionIds: initialHiddenSessionIds, deletedSessionIds: initialDeletedSessionIds, unreadSessionIds: initialUnreadSessionIds, pinnedSessionIds: initialPinnedSessionIds, mutedSessionIds: initialMutedSessionIds, pinnedGroupSpaceIds: initialPinnedGroupSpaceIds, cursor: previousCursor, fallbackRequired: true, hasMore: false };
  }

  const nextCursor = normalizeCursor(response.cursor);
  if (cloudSyncCursorRequiresFallback(previousCursor, nextCursor, Boolean(response.hasMore))) {
    return { messagesByPeer: input.messagesByPeer, sessionActivity: input.sessionActivity ?? EMPTY_CLOUD_SESSION_ACTIVITY, sessionForksById: input.sessionForksById ?? {}, sessionPinsById: input.sessionPinsById ?? {}, sessionTitlesById: input.sessionTitlesById ?? {}, cloudAgentsById: input.cloudAgentsById ?? {}, hiddenSessionIds: initialHiddenSessionIds, deletedSessionIds: initialDeletedSessionIds, unreadSessionIds: initialUnreadSessionIds, pinnedSessionIds: initialPinnedSessionIds, mutedSessionIds: initialMutedSessionIds, pinnedGroupSpaceIds: initialPinnedGroupSpaceIds, cursor: previousCursor, fallbackRequired: true, hasMore: false };
  }

  const events = response.events ?? [];
  const visibility = applyCloudSyncEventsToSessionVisibility(input.accountId, {
    hiddenSessionIds: initialHiddenSessionIds,
    deletedSessionIds: initialDeletedSessionIds,
    unreadSessionIds: initialUnreadSessionIds,
    pinnedSessionIds: initialPinnedSessionIds,
    mutedSessionIds: initialMutedSessionIds,
    pinnedGroupSpaceIds: initialPinnedGroupSpaceIds,
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
  if (input.commitResponse) {
    await input.commitResponse(response);
  } else if (!input.shouldSaveCursor || input.shouldSaveCursor()) {
    saveCloudSyncCursor(input.accountId, nextCursor, storage);
  }
  return { messagesByPeer, sessionActivity, sessionForksById, sessionPinsById, sessionTitlesById, cloudAgentsById, hiddenSessionIds: visibility.hiddenSessionIds, deletedSessionIds: visibility.deletedSessionIds, unreadSessionIds: visibility.unreadSessionIds, pinnedSessionIds: visibility.pinnedSessionIds, mutedSessionIds: visibility.mutedSessionIds, pinnedGroupSpaceIds: visibility.pinnedGroupSpaceIds, cursor: nextCursor, fallbackRequired: false, hasMore: Boolean(response.hasMore) };
}
