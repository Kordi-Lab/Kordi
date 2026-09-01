import type {
  CanonicalSessionState,
  DesktopCollaborationState,
} from '@/kordi-app/types';
import type { CloudMessage } from './authClient';
import { cloudDirectMessageIsUnreadForAccount } from './cloudAgentMessages';
import {
  cloudGroupUnreadCountsBySessionId,
  isCloudGroupSessionId,
  parseCloudGroupControl,
  type CloudGroupReadCursor,
} from './cloudGroupMessages';
import type { IndexedCloudGroupRow } from './cloudMessageIndex';

function objectContent(value: unknown): Record<string, unknown> {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function cloudUnreadCountsBySessionId({
  accountId,
  messagesByPeer,
  readInboundMessageIdsByPeer = {},
  readCursorsBySessionId = {},
}: {
  accountId: string;
  messagesByPeer: Readonly<Record<string, readonly CloudMessage[]>>;
  readInboundMessageIdsByPeer?: Readonly<Record<string, ReadonlySet<string>>>;
  readCursorsBySessionId?: Readonly<Record<string, CloudGroupReadCursor | null | undefined>>;
}): Record<string, number> {
  const unreadBySessionId: Record<string, number> = {};
  const groupRows: IndexedCloudGroupRow[] = [];

  for (const [peerId, messages] of Object.entries(messagesByPeer)) {
    const locallyReadIds = readInboundMessageIdsByPeer[peerId];
    for (const message of messages) {
      const envelope = parseCloudGroupControl(message.body);
      if (envelope) {
        if (locallyReadIds?.has(message.messageId)) continue;
        const reliableWire = message.readAt
          && message.conversationId
          && Number.isSafeInteger(message.conversationSequence)
            ? { ...message, readAt: null }
            : message;
        groupRows.push({
          wire: reliableWire,
          envelope,
          canonicalMessageId: envelope.message?.id?.trim() || null,
        });
        continue;
      }
      const sessionId = message.sessionId?.trim() || message.conversationId?.trim();
      if (
        !sessionId
        || isCloudGroupSessionId(sessionId)
        || locallyReadIds?.has(message.messageId)
        || !cloudDirectMessageIsUnreadForAccount(message, accountId)
      ) continue;
      unreadBySessionId[sessionId] = (unreadBySessionId[sessionId] ?? 0) + 1;
    }
  }

  const groupUnread = cloudGroupUnreadCountsBySessionId({
    accountId,
    readCursorsBySessionId,
    groupRows,
  });
  for (const [sessionId, count] of Object.entries(groupUnread)) {
    unreadBySessionId[sessionId] = (unreadBySessionId[sessionId] ?? 0) + count;
  }
  return unreadBySessionId;
}

export function cloudOptimisticallyReadSessionIds({
  messagesByPeer,
  readInboundMessageIdsByPeer,
}: {
  messagesByPeer: Readonly<Record<string, readonly CloudMessage[]>>;
  readInboundMessageIdsByPeer: Readonly<Record<string, ReadonlySet<string>>>;
}): Set<string> {
  const sessionIds = new Set<string>();
  for (const [peerId, messageIds] of Object.entries(readInboundMessageIdsByPeer)) {
    for (const message of messagesByPeer[peerId] ?? []) {
      if (!messageIds.has(message.messageId)) continue;
      const sessionId = parseCloudGroupControl(message.body)?.groupId?.trim()
        || message.sessionId?.trim()
        || message.conversationId?.trim();
      if (sessionId) sessionIds.add(sessionId);
    }
  }
  return sessionIds;
}

export function mergeNativeCloudUnreadCounts({
  nativeHeadsBySessionId,
  optimisticSessionIds,
  projectedUnreadBySessionId,
}: {
  nativeHeadsBySessionId: Readonly<Record<string, {
    lastReadSequence: number;
    unreadCount: number;
  }>>;
  optimisticSessionIds: ReadonlySet<string>;
  projectedUnreadBySessionId: Readonly<Record<string, number>> | null;
}): Record<string, number> {
  const counts = Object.fromEntries(Object.entries(nativeHeadsBySessionId).map(
    ([sessionId, head]) => [sessionId, head.unreadCount],
  ));
  for (const [sessionId, count] of Object.entries(projectedUnreadBySessionId ?? {})) {
    const nativeHead = nativeHeadsBySessionId[sessionId];
    if (!nativeHead || nativeHead.lastReadSequence === 0) {
      counts[sessionId] = Math.max(counts[sessionId] ?? 0, count);
    }
  }
  for (const sessionId of optimisticSessionIds) {
    if ((projectedUnreadBySessionId?.[sessionId] ?? 0) === 0) counts[sessionId] = 0;
  }
  return counts;
}

export function patchCloudCollaborationUnreadCounts(
  state: DesktopCollaborationState,
  unreadBySessionId: Readonly<Record<string, number>>,
): DesktopCollaborationState {
  let changed = false;
  const conversations = state.conversations.map((conversation) => {
    const unreadCount = unreadBySessionId[conversation.canonicalSessionId] ?? 0;
    if (conversation.unreadCount === unreadCount) return conversation;
    changed = true;
    return { ...conversation, unreadCount };
  });
  return changed ? { ...state, conversations } : state;
}

export function patchCanonicalCloudUnreadCounts(
  state: CanonicalSessionState | null,
  unreadBySessionId: Readonly<Record<string, number>>,
): CanonicalSessionState | null {
  if (!state) return state;
  let changed = false;
  const sessions = state.sessions.map((session) => {
    const metadata = objectContent(session.metadata);
    const existingUnread =
      typeof metadata.cloudUnreadCount === 'number'
      && Number.isFinite(metadata.cloudUnreadCount)
        ? Math.max(0, Math.floor(metadata.cloudUnreadCount))
        : 0;
    const nextUnread = unreadBySessionId[session.id] ?? 0;
    if (existingUnread === nextUnread) return session;
    changed = true;
    if (nextUnread > 0) {
      return {
        ...session,
        metadata: {
          ...metadata,
          cloudUnreadCount: nextUnread,
        },
      };
    }
    const restMetadata = { ...metadata };
    delete restMetadata.cloudUnreadCount;
    return {
      ...session,
      metadata: restMetadata,
    };
  });
  return changed ? { ...state, sessions } : state;
}
