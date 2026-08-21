import { useEffect, useRef } from 'react';

import type { DesktopChatTurnSnapshot } from '@/kordi-app/types';
import { fetchDesktopChatActiveTurns } from '@/lib/desktopBackgroundSessions';

export function useBackgroundTurnDiscovery({
  enabled,
  watchTurn,
}: {
  enabled: boolean;
  watchTurn: (turn: DesktopChatTurnSnapshot) => Promise<void>;
}) {
  const discoveredTurnIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const discover = async () => {
      const turns = await fetchDesktopChatActiveTurns().catch(() => []);
      if (cancelled) return;
      const currentIds = new Set(turns.map((turn) => turn.id));
      for (const turn of turns) {
        if (discoveredTurnIdsRef.current.has(turn.id)) continue;
        discoveredTurnIdsRef.current.add(turn.id);
        void watchTurn(turn);
      }
      for (const turnId of discoveredTurnIdsRef.current) {
        if (!currentIds.has(turnId)) discoveredTurnIdsRef.current.delete(turnId);
      }
    };

    void discover();
    const interval = window.setInterval(discover, 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [enabled, watchTurn]);
}
