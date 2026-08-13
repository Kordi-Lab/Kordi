export async function selectDesktopSessionAndPreloadTranscript({
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
  if (!isSelectionCurrent()) return false;
  selectSession(sessionId);
  if (isTranscriptCached(sessionId)) return true;
  await preloadTranscript(sessionId).catch(() => false);
  return isSelectionCurrent();
}
