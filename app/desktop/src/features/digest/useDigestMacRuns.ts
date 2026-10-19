import { useEffect, useRef } from 'react';
import type { CloudAccount, CloudAuthClient } from '@/features/cloud/authClient';
import { loadSession } from '@/features/cloud/session';
import type { DesktopChatMessageRoute } from '@/lib/desktop';
import { digestClient } from './client';
import { runDigestOnMac, setDigestRunRequestHandler } from './digestMacRuns';

/** Runs this account's digest runs on this Mac while its runtime is ready. */
export function useDigestMacRuns({
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
    // One attempt per run: a run this Mac released belongs to the cloud.
    const started = new Set<string>();
    setDigestRunRequestHandler((request) => {
      if (started.has(request.runId)) return;
      started.add(request.runId);
      void (async () => {
        const session = await loadSession();
        if (!session?.token || session.accountId !== accountId) return;
        const { client: current, defaultRoute: route } = latest.current;
        await runDigestOnMac(request, {
          accountId, token: session.token, route, client: current,
          post: (path, body) => digestClient.desktopRun(accountId, path, body),
        });
      })().catch((error) => latest.current.reportWarning('[digest] run on this Mac failed', error));
    });
    return () => setDigestRunRequestHandler(null);
  }, [accountId, runtimeReady]);
}
