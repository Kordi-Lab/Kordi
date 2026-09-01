import type { Conversation } from '@/kordi-app/types';

function addUnread(unreadBySessionId: Map<string, number>, sessionId: string | null | undefined, count: number | null | undefined) {
  const id = sessionId?.trim();
  const unread = Math.max(0, count ?? 0);
  if (id && unread > 0) unreadBySessionId.set(id, (unreadBySessionId.get(id) ?? 0) + unread);
}

export function mergedUnreadBySessionId(conversations: Conversation[]) {
  const unreadBySessionId = new Map<string, number>();
  for (const conversation of conversations) {
    const scopedEntries = Object.entries(conversation.collaborationUnreadByParentSessionId ?? {});
    if (scopedEntries.length > 0) {
      for (const [sessionId, unread] of scopedEntries) addUnread(unreadBySessionId, sessionId, unread);
    } else {
      addUnread(unreadBySessionId, conversation.canonicalSessionId ?? conversation.id, conversation.unread);
    }
  }
  return unreadBySessionId;
}

export function withMergedUnreadForSession<T extends Conversation>(conversation: T, sessionId: string, unread: number): T {
  return {
    ...conversation,
    unread,
    collaborationUnreadByParentSessionId: { ...(conversation.collaborationUnreadByParentSessionId ?? {}), [sessionId]: unread },
  };
}
