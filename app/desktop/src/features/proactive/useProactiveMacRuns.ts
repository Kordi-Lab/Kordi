import { useEffect, useRef } from 'react';
import type { CloudAccount, CloudAuthClient } from '@/features/cloud/authClient';
import { loadSession } from '@/features/cloud/session';
import type { DesktopChatMessageRoute } from '@/lib/desktop';
import { runProactiveOnMac, setProactiveRunRequestHandler } from './proactiveMacRuns';

/** Runs this account's proactive evaluations and allowed offers on this Mac while its runtime is ready. */
export function useProactiveMacRuns({
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
    return setProactiveRunRequestHandler(accountId, (request) => {
      void (async () => {
        const session = await loadSession();
        if (!session?.token || session.accountId !== accountId) return;
        const { client: current, defaultRoute: route, reportWarning: report } = latest.current;
        await runProactiveOnMac(request, { accountId, token: session.token, route, client: current, report });
      })().catch((error) => latest.current.reportWarning('[proactive-mac] run on this Mac failed', error));
    });
  }, [accountId, runtimeReady]);
}
