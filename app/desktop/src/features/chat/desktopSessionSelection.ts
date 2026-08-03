export async function commitDesktopSessionSelectionAfterTranscriptReady({
  sessionId,
  isTranscriptCached,
  preloadTranscript,
  isSelectionCurrent,
  selectSession,
}: {
  sessionId: string;
  isTranscriptCached: (candidateSessionId: string) => boolean;
  preloadTranscript: (candidateSessionId: string) => Promise<boolean>;
  isSelectionCurrent: () => boolean;
  selectSession: (candidateSessionId: string) => void;
}): Promise<boolean> {
  if (!isTranscriptCached(sessionId)) {
    await preloadTranscript(sessionId).catch(() => false);
  }
  if (!isSelectionCurrent()) return false;
  selectSession(sessionId);
  return true;
}
