import type { CloudSessionTitle } from './authClient';
import type { IndexedCloudGroupRow } from './cloudMessageIndex';

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

export function reliableCloudGroupSessionMessageCounts(
  rowsBySessionId: ReadonlyMap<string, readonly IndexedCloudGroupRow[]>,
) {
  const counts = new Map<string, number>();
  for (const [sessionId, rows] of rowsBySessionId) {
    for (const row of rows) {
      const sequence = row.wire.conversationSequence;
      if (Number.isSafeInteger(sequence) && Number(sequence) > 0) {
        counts.set(sessionId, Math.max(counts.get(sessionId) ?? 0, Number(sequence)));
      }
    }
  }
  return counts;
}
