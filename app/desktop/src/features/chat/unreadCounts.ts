type UnreadSession = {
  id: string;
  canonicalSessionId?: string | null;
  forkedFromSessionId?: string | null;
  unread?: number | null;
};

function preferenceId(session: UnreadSession) {
  return (session.canonicalSessionId || session.id).trim();
}

export function effectiveSessionUnread(
  session: UnreadSession,
  mutedSessionIds: ReadonlySet<string>,
  unreadSessionIds: ReadonlySet<string>,
) {
  const sessionId = preferenceId(session);
  if (!sessionId || mutedSessionIds.has(sessionId)) return 0;
  return Math.max(unreadSessionIds.has(sessionId) ? 1 : 0, session.unread ?? 0);
}

export function totalVisibleUnread(
  sessions: readonly UnreadSession[],
  mutedSessionIds: ReadonlySet<string>,
  unreadSessionIds: ReadonlySet<string>,
) {
  return sessions.reduce(
    (sum, session) => sum + effectiveSessionUnread(session, mutedSessionIds, unreadSessionIds),
    0,
  );
}

// The selected archive stays available for reading, but must not contribute to
// global badges or message notifications. Match both UI and canonical IDs.
export function sessionsForGlobalAttention<T extends UnreadSession>(
  sessions: readonly T[],
  hiddenSessionIds: ReadonlySet<string>,
): T[] {
  return sessions.filter((session) => (
    !hiddenSessionIds.has(session.id)
    && !hiddenSessionIds.has(preferenceId(session))
  ));
}
