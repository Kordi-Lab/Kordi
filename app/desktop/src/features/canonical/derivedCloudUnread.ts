import type { CanonicalSessionState } from '@/kordi-app/types';

function metadataRecord(metadata: unknown): Record<string, unknown> {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
}

function derivedCloudUnreadCount(session: { metadata?: unknown }) {
  const value = metadataRecord(session.metadata).cloudUnreadCount;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Keeps the unread counts this renderer published on sessions that a newer
 * catalog or replay result returns without them. Stored and replayed copies do
 * not carry the renderer's count, so taking them as they are would flash every
 * unread badge to zero and back until reconciliation published it again.
 * Reconciliation clears a count by writing zero, never by removing it.
 */
export function carryDerivedCloudUnreadCounts<Catalog extends { sessions: CanonicalSessionState['sessions'] }>(
  previous: Catalog | null | undefined,
  next: Catalog | null,
): Catalog | null {
  if (!previous || !next || previous === next) return next;
  let previousUnread: Map<string, number> | null = null;
  for (const session of previous.sessions) {
    const unread = derivedCloudUnreadCount(session);
    if (unread !== undefined && unread > 0) (previousUnread ??= new Map()).set(session.id, unread);
  }
  if (!previousUnread) return next;
  let changed = false;
  const sessions = next.sessions.map((session) => {
    const unread = previousUnread.get(session.id);
    if (unread === undefined || derivedCloudUnreadCount(session) !== undefined) return session;
    changed = true;
    return { ...session, metadata: { ...metadataRecord(session.metadata), cloudUnreadCount: unread } };
  });
  return changed ? { ...next, sessions } : next;
}
