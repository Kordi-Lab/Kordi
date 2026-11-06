import { useCallback, useEffect, useState } from 'react';

import { isNativeDesktopShell } from '@/lib/desktop';
import {
  fetchDesktopBackgroundSessionRoute,
  setDesktopBackgroundSessionRoute,
  type DesktopBackgroundSessionRoute,
} from '@/lib/desktopBackgroundSessions';

/**
 * The route of a background session this Mac runs: the parent turn's model
 * and account unless the owner picked another model. Null when the session
 * runs elsewhere.
 */
export function useBackgroundSessionRoute(sessionId: string | null, enabled: boolean) {
  const [loaded, setLoaded] = useState<{ sessionId: string; route: DesktopBackgroundSessionRoute | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setError(null);
    if (!sessionId || !enabled || !isNativeDesktopShell()) return undefined;
    let cancelled = false;
    void fetchDesktopBackgroundSessionRoute(sessionId)
      .then((route) => { if (!cancelled) setLoaded({ sessionId, route }); })
      .catch(() => { if (!cancelled) setLoaded({ sessionId, route: null }); });
    return () => { cancelled = true; };
  }, [enabled, sessionId]);
  const route = enabled && loaded?.sessionId === sessionId && loaded.route?.model ? loaded.route : null;
  const select = useCallback(async (model: string, thinking: string | null) => {
    if (!sessionId) return false;
    try {
      const next = await setDesktopBackgroundSessionRoute(sessionId, model, thinking);
      setLoaded({ sessionId, route: next });
      setError(null);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  }, [sessionId]);
  return { route, error, select };
}
