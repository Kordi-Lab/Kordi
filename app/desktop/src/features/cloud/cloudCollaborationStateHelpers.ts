import type { CloudSessionTitle } from './authClient';
import type { IndexedCloudGroupRow } from './cloudMessageIndex';
import type { CanonicalSessionState } from '@/kordi-app/types';

export function patchCanonicalCloudGroupSessionTitles(
  state: CanonicalSessionState | null,
  syncedTitles: Record<string, CloudSessionTitle>,
): CanonicalSessionState | null {
  if (!state) return state;
  let changed = false;
  const sessions = state.sessions.map((session) => {
    const snapshot = syncedTitles[session.id];
    const title = snapshot?.title.trim() ?? '';
    if (session.kind !== 'group' || !title) return session;
    const metadata = session.metadata && typeof session.metadata === 'object'
      && !Array.isArray(session.metadata)
      ? session.metadata as Record<string, unknown>
      : {};
    if (metadata.sessionTitleSource === 'manual') return session;
    if (
      session.title === title
      && metadata.sessionTitleSource === 'external'
      && metadata.sessionTitleRevision === snapshot.titleRevision
    ) return session;
    changed = true;
    return {
      ...session,
      title,
      metadata: {
        ...metadata,
        sessionTitleSource: 'external',
        sessionTitleRevision: snapshot.titleRevision,
        sessionTitleUpdatedAtMs: snapshot.updatedAtMs,
      },
    };
  });
  return changed ? { ...state, sessions } : state;
}

export function cloudGroupSessionTitlesForReadModel(
  syncedTitles: Record<string, Pick<CloudSessionTitle, 'title'>>,
) {
  const merged = new Map<string, string>();
  for (const [sessionId, snapshot] of Object.entries(syncedTitles)) {
    const title = snapshot.title.trim();
    if (sessionId.startsWith('session:group:') && title) merged.set(sessionId, title);
  }
  return merged;
}

export function reliableCloudGroupSessionTitleIds(
  syncedTitles: Record<string, Pick<CloudSessionTitle, 'title'>>,
) {
  return new Set(
    Object.entries(syncedTitles).flatMap(([sessionId, snapshot]) => (
      sessionId.startsWith('session:group:') && snapshot.title.trim()
        ? [sessionId]
        : []
    )),
  );
}

export function reliableCloudGroupSessionActivityAtMs(
  rowsBySessionId: ReadonlyMap<string, readonly IndexedCloudGroupRow[]>,
) {
  const activity = new Map<string, number>();
  for (const [sessionId, rows] of rowsBySessionId) {
    for (const row of rows) {
      const createdAtMs = Date.parse(row.wire.createdAt);
      if (Number.isFinite(createdAtMs)) {
        activity.set(sessionId, Math.max(activity.get(sessionId) ?? 0, createdAtMs));
      }
    }
  }
  return activity;
}
