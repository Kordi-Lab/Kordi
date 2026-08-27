import type { CloudSessionTitle } from './authClient';

export function cloudGroupSessionTitlesForReadModel(
  legacyTitles: ReadonlyMap<string, string>,
  syncedTitles: Record<string, Pick<CloudSessionTitle, 'title'>>,
) {
  const merged = new Map(legacyTitles);
  for (const [sessionId, snapshot] of Object.entries(syncedTitles)) {
    const title = snapshot.title.trim();
    if (sessionId.startsWith('session:group:') && title) merged.set(sessionId, title);
  }
  return merged;
}
