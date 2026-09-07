import { useEffect, useRef } from 'react';

import type { DesktopChatTurnSnapshot } from '@/kordi-app/types';
import { fetchDesktopChatActiveTurns, fetchDesktopSubsessionIds } from '@/lib/desktopBackgroundSessions';
import { publishModelSubsession } from '@/features/cloud/agentSubsessionSync';
import { loadSession } from '@/features/cloud/session';
import { discoverSubsessionFollowups } from '@/features/cloud/subsessionFollowExecution';

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
    let recovered = false;
    let recoveryAccountId: string | null = null;

    const discover = async () => {
      void discoverSubsessionFollowups().catch(()=>undefined);
      const accountId = (await loadSession())?.accountId ?? null;
      if (accountId !== recoveryAccountId) { recoveryAccountId = accountId; recovered = false; discoveredTurnIdsRef.current.clear(); }
      const turns = await fetchDesktopChatActiveTurns().catch(() => []);
      const subsessionIds = new Set(await fetchDesktopSubsessionIds().catch(() => []));
      if (cancelled) return;
      if (!recovered && accountId) {
        recovered = true;
        for (const id of subsessionIds) void publishModelSubsession(id).catch(() => undefined);
      }
      const currentIds = new Set(turns.map((turn) => turn.id));
      for (const turn of turns) {
        if (discoveredTurnIdsRef.current.has(turn.id)) continue;
        discoveredTurnIdsRef.current.add(turn.id);
        if (subsessionIds.has(turn.sessionId)) void publishModelSubsession(turn.sessionId).catch(() => undefined);
        else void watchTurn(turn);
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
