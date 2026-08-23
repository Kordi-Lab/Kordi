import type { CloudMessage, CloudSyncEvent } from './authClient';
import { cloudMessageMetadataOnly } from './cloudMessageCache';
import {
  compareCloudMessages,
  latestCloudReceiptAt,
  mergeCloudMessageMonotonicState,
  normalizeCloudReaderAccountIds,
} from './cloudMessageMerge';

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
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
  const attachments = Array.isArray(record.attachments)
    ? record.attachments as CloudMessage['attachments']
    : undefined;
  const conversationSequence = Number.isSafeInteger(record.conversationSequence)
    && Number(record.conversationSequence) > 0
    ? Number(record.conversationSequence)
    : null;
  const version = Number.isSafeInteger(record.version) && Number(record.version) > 0
    ? Number(record.version)
    : null;
  const readByAccountIds = normalizeCloudReaderAccountIds(record.readByAccountIds);
  return cloudMessageMetadataOnly({
    messageId,
    fromAccountId,
    toAccountId,
    body: typeof record.body === 'string' ? record.body : '',
    createdAt,
    deliveredAt: typeof record.deliveredAt === 'string' ? record.deliveredAt : null,
    readAt: typeof record.readAt === 'string' ? record.readAt : null,
    ...(readByAccountIds !== undefined ? { readByAccountIds } : {}),
    direction,
    ...(typeof record.sessionId === 'string' ? { sessionId: record.sessionId } : {}),
    ...(typeof record.conversationId === 'string' ? { conversationId: record.conversationId } : {}),
    ...(conversationSequence ? { conversationSequence } : {}),
    ...(typeof record.clientMessageId === 'string' ? { clientMessageId: record.clientMessageId } : {}),
    ...(typeof record.messageKind === 'string' ? { messageKind: record.messageKind } : {}),
    ...(typeof record.canonicalHistoryLocalMessageId === 'string'
      ? { canonicalHistoryLocalMessageId: record.canonicalHistoryLocalMessageId }
      : {}),
    ...(version ? { version } : {}),
    ...(attachments ? { attachments } : {}),
  });
}

function messagePeerId(
  accountId: string,
  message: CloudMessage,
  eventPeerId?: string | null,
): string | null {
  const eventPeer = eventPeerId?.trim() ?? '';
  if (eventPeer) return eventPeer;
  if (message.fromAccountId === accountId) return message.toAccountId;
  if (message.toAccountId === accountId) return message.fromAccountId;
  return null;
}

export function payloadCloudSyncMessage(event: CloudSyncEvent): CloudMessage | null {
  const payload = objectRecord(event.payload);
  return normalizeCloudMessage(payload?.message);
}

export function cloudSyncEventSessionId(event: CloudSyncEvent): string {
  const payload = objectRecord(event.payload);
  return cleanText(payload?.sessionId) || cleanText(event.peerAccountId);
}

function directPersonSessionId(accountId: string, peerId: string): string {
  return `session:direct-person:${[accountId.trim(), peerId.trim()].filter(Boolean).sort().join(':')}`;
}

export function cloudMessageSessionKeys(
  accountId: string,
  message: CloudMessage,
  eventPeerId?: string | null,
): string[] {
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

function messageMatchesSession(
  accountId: string,
  message: CloudMessage,
  sessionId: string,
  peerId?: string | null,
): boolean {
  return cloudMessageSessionKeys(accountId, message, peerId).includes(sessionId);
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
    const retained = messages.filter(
      (message) => !messageMatchesSession(accountId, message, trimmedSessionId, peerId),
    );
    if (retained.length !== messages.length) changed = true;
    if (retained.length > 0) {
      next[peerId] = retained.length === messages.length ? messages : retained;
    }
  }
  return changed ? next : currentMessagesByPeer;
}

function readReceiptPayload(
  event: CloudSyncEvent,
): { messageIds: string[]; readAt: string } | null {
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
  const hiddenSessionIds = new Set(initialHiddenSessionIds);
  const deletedSessionIds = new Set(initialDeletedSessionIds);
  const indexedMessagesByPeer = new Map<string, Map<string, CloudMessage>>();
  const changedPeerIds = new Set<string>();

  const indexedPeerMessages = (peerId: string) => {
    const existing = indexedMessagesByPeer.get(peerId);
    if (existing) return existing;
    const indexed = new Map(
      (currentMessagesByPeer[peerId] ?? []).map((message) => [message.messageId, message]),
    );
    indexedMessagesByPeer.set(peerId, indexed);
    return indexed;
  };

  const removeSessionMessages = (sessionId: string) => {
    for (const peerId of new Set([
      ...Object.keys(currentMessagesByPeer),
      ...indexedMessagesByPeer.keys(),
    ])) {
      const indexed = indexedPeerMessages(peerId);
      let changed = false;
      for (const [messageId, message] of indexed) {
        if (!messageMatchesSession(accountId, message, sessionId, peerId)) continue;
        indexed.delete(messageId);
        changed = true;
      }
      if (changed) changedPeerIds.add(peerId);
    }
  };

  for (const event of events) {
    if (event.eventType === 'session.hidden') {
      const sessionId = cloudSyncEventSessionId(event);
      if (sessionId && !deletedSessionIds.has(sessionId)) hiddenSessionIds.add(sessionId);
      continue;
    }

    if (event.eventType === 'session.unhidden') {
      const sessionId = cloudSyncEventSessionId(event);
      if (sessionId) hiddenSessionIds.delete(sessionId);
      continue;
    }

    if (event.eventType === 'session.deleted') {
      const sessionId = cloudSyncEventSessionId(event);
      if (!sessionId) continue;
      hiddenSessionIds.delete(sessionId);
      deletedSessionIds.add(sessionId);
      removeSessionMessages(sessionId);
      continue;
    }

    if (event.eventType === 'message.upsert') {
      const message = payloadCloudSyncMessage(event);
      if (!message) continue;
      const peerId = messagePeerId(accountId, message, event.peerAccountId);
      if (!peerId) continue;
      for (const key of cloudMessageSessionKeys(accountId, message, event.peerAccountId)) {
        hiddenSessionIds.delete(key);
        deletedSessionIds.delete(key);
      }
      const indexed = indexedPeerMessages(peerId);
      const existing = indexed.get(message.messageId);
      const merged = existing
        ? mergeCloudMessageMonotonicState(existing, message)
        : message;
      if (merged !== existing) {
        indexed.set(message.messageId, merged);
        changedPeerIds.add(peerId);
      }
      continue;
    }

    if (event.eventType !== 'message.read') continue;
    const receipt = readReceiptPayload(event);
    const peerId = event.peerAccountId?.trim() ?? '';
    if (
      !receipt
      || !peerId
      || (!(peerId in currentMessagesByPeer) && !indexedMessagesByPeer.has(peerId))
    ) continue;
    const indexed = indexedPeerMessages(peerId);
    for (const messageId of receipt.messageIds) {
      const message = indexed.get(messageId);
      if (!message) continue;
      const deliveredAt = message.deliveredAt ?? receipt.readAt;
      const readAt = latestCloudReceiptAt(message.readAt, receipt.readAt);
      if (message.deliveredAt === deliveredAt && message.readAt === readAt) continue;
      indexed.set(messageId, { ...message, deliveredAt, readAt });
      changedPeerIds.add(peerId);
    }
  }

  if (changedPeerIds.size === 0) return currentMessagesByPeer;
  const next = { ...currentMessagesByPeer };
  for (const peerId of changedPeerIds) {
    const messages = [...indexedPeerMessages(peerId).values()].sort(compareCloudMessages);
    if (messages.length > 0) next[peerId] = messages;
    else delete next[peerId];
  }
  return next;
}
