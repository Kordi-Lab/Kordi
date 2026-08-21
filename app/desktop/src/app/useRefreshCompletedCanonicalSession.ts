import { useCallback } from 'react';

type HydrateSessionPage = (
  sessionId: string,
  options?: { beforeSequenceNum?: number | null; force?: boolean },
) => Promise<unknown>;

export function useRefreshCompletedCanonicalSession(
  refreshState: () => Promise<unknown>,
  hydrateSessionPage: HydrateSessionPage,
) {
  return useCallback(async (sessionId: string) => {
    await refreshState();
    return hydrateSessionPage(sessionId, { force: true });
  }, [hydrateSessionPage, refreshState]);
}
