import { useEffect, useRef } from 'react';
import type { CloudAccount, CloudAuthClient } from './authClient';
import { loadSession } from './session';
import type { DesktopChatMessageRoute } from '@/lib/desktop';
import { discoverScheduledMacRuns } from './scheduledMacRuns';

/** How often this Mac looks for scheduled runs the server holds for it. */
export const SCHEDULED_MAC_RUN_POLL_MS = 15_000;

/** Runs this account's scheduled tasks on this Mac while its runtime is ready. */
export function useScheduledMacRuns({
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
      await discoverScheduledMacRuns({ accountId, token: session.token, route, client: current }, started);
    };
    const tick = () => { void discover().catch((error) => latest.current.reportWarning('[scheduled] run on this Mac failed', error)); };
    tick();
    const timer = window.setInterval(tick, SCHEDULED_MAC_RUN_POLL_MS);
    return () => window.clearInterval(timer);
  }, [accountId, runtimeReady]);
}
