import type {
  CanonicalSessionState,
} from '@/kordi-app/types';

function objectContent(value: unknown): Record<string, unknown> {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
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
