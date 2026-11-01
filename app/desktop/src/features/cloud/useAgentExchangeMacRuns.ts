import { useEffect, useRef } from 'react';
import type { CloudAccount, CloudAuthClient } from './authClient';
import { loadSession } from './session';
import type { DesktopChatMessageRoute } from '@/lib/desktop';
import { discoverAgentExchangeMacRuns } from './agentExchangeMacRuns';

/** How often this Mac looks for agent requests and continuations the server holds for it. */
export const AGENT_EXCHANGE_POLL_MS = 3_000;

/** Runs this account's agent requests and continuations on this Mac while its runtime is ready. */
export function useAgentExchangeMacRuns({
  account,
  client,
  defaultRoute,
  runtimeReady,
  reportWarning,
}: {
  account: CloudAccount | null;
  client: CloudAuthClient;
  defaultRoute?: DesktopChatMessageRoute | null;
  runtimeReady: boolean;
  reportWarning: (message: string, error: unknown) => void;
}) {
  const accountId = account?.accountId ?? null;
  const latest = useRef({ client, defaultRoute, reportWarning });
  useEffect(() => {
    latest.current = { client, defaultRoute, reportWarning };
  }, [client, defaultRoute, reportWarning]);
  useEffect(() => {
    if (!accountId || !runtimeReady) return;
    const started = new Set<string>();
    const discover = async () => {
      const session = await loadSession();
      if (!session?.token || session.accountId !== accountId) return;
      const { client: current, defaultRoute: route } = latest.current;
      await discoverAgentExchangeMacRuns({ accountId, token: session.token, route, client: current }, started);
    };
    let discovering = false;
    const tick = () => {
      if (discovering) return;
      discovering = true;
      void discover().catch((error) => latest.current.reportWarning('[agent-exchange] run on this Mac failed', error)).finally(() => { discovering = false; });
    };
    tick();
    const timer = window.setInterval(tick, AGENT_EXCHANGE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [accountId, runtimeReady]);
}
