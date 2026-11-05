import { useProjectSync } from '@/features/projects/projectSync';
import { isNativeDesktopShell } from '@/lib/desktop';
import { useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { CanonicalSessionState, DesktopChatTurnSnapshot } from '@/kordi-app/types';
import type { DesktopChatMessageRoute } from '@/lib/desktop';
import type { CloudAccount, CloudAuthClient, CloudMessage } from './authClient';
import type { CloudAgentDefinition } from './cloudAgents';
import type { CloudMessageIndex } from './cloudMessageIndex';
import { defaultCloudAgentId } from './cloudAgentIdentity';
import { loadSession } from './session';
import { CloudAuthError } from './cloudAuthError';
import { endRejectedCloudSession, isCloudSessionRejected } from './cloudSessionRejection';
import { macCanRunDigest } from '@/features/digest/digestMacRuns';
import { withDeadline } from '@/lib/promiseDeadline';

/**
 * Longest one readiness publication may hold the serialized chain. Requests
 * already time out sooner; this bound keeps a reply that never arrives (a
 * webview reload mid-command) from stopping every later heartbeat.
 */
export const DESKTOP_READINESS_PUBLICATION_DEADLINE_MS = 60_000;

/** How often this Mac renews its readiness while the server accepts it. */
export const DESKTOP_READINESS_INTERVAL_MS = 10_000;
/** Longest wait between retries while the server cannot be reached. */
export const DESKTOP_READINESS_MAX_RETRY_MS = 5 * 60_000;

/** Wait before the next attempt after `failures` transient failures in a row. */
export function desktopReadinessRetryDelayMs(failures: number, error?: unknown): number {
  const backoff = Math.min(DESKTOP_READINESS_INTERVAL_MS * 2 ** Math.max(0, failures - 1), DESKTOP_READINESS_MAX_RETRY_MS);
  const retryAfterMs = error instanceof CloudAuthError && error.retryAfterSeconds !== undefined
    ? Math.min(error.retryAfterSeconds * 1000, DESKTOP_READINESS_MAX_RETRY_MS)
    : 0;
  return Math.max(backoff, retryAfterMs);
}

export type CloudSelfAgentExecutionInput = {
  account: CloudAccount | null;
  canonicalState: CanonicalSessionState | null | undefined;
  client: CloudAuthClient;
  messageIndex: CloudMessageIndex;
  initialMessagesSettled: boolean;
  runtimeReady?: boolean;
  routesBySessionId?: Record<string, DesktopChatMessageRoute>;
  defaultRoute?: DesktopChatMessageRoute | null;
  cloudAgentDefinitionsById?: Record<string, CloudAgentDefinition>;
  processedRequestIdsRef: MutableRefObject<Set<string>>;
  turnIdsByRequestIdRef: MutableRefObject<Map<string, string>>;
  setLocalTurns: Dispatch<SetStateAction<Record<string, DesktopChatTurnSnapshot>>>;
  mergeMessage: (message: CloudMessage) => void;
  syncMessages: () => Promise<void>;
  reportWarning: (message: string, error: unknown) => void;
  /** Reloads a session's latest canonical page, for rows the native side wrote. */
  hydrateSessionPage?: (sessionId: string, options?: { force?: boolean }) => Promise<unknown>;
};

export function useDesktopAgentReadiness({
  account, client, runtimeReady = true, cloudAgentDefinitionsById, defaultRoute, reportWarning,
}: Pick<CloudSelfAgentExecutionInput, 'account' | 'client' | 'runtimeReady' | 'cloudAgentDefinitionsById' | 'defaultRoute' | 'reportWarning'>) {
  const accountId = account?.accountId;
  useProjectSync(isNativeDesktopShell() && runtimeReady, accountId);
  const agentIdsKey = JSON.stringify(runtimeReady && accountId
    ? [...new Set([defaultCloudAgentId(accountId), ...Object.values(cloudAgentDefinitionsById ?? {})
      .filter(agent => agent.ownerAccountId === accountId && agent.status !== 'archived')
      .map(agent => agent.agentId)])].sort()
    : []);
  // Digest runs and scheduled tasks wait for this Mac whenever it can run the
  // owner's default route, a hosted account included, as chat runs do.
  const scheduled = Boolean(runtimeReady && accountId && macCanRunDigest(defaultRoute));
  const digest = scheduled;
  // Proactive evaluations and allowed offers wait for this Mac on the same terms.
  const proactive = digest;
  const readinessKey = JSON.stringify([accountId, agentIdsKey, digest, scheduled, proactive]);
  const registration = useMemo(() => ({ readinessKey, client }), [readinessKey, client]);
  const publicationTail = useRef(Promise.resolve());
  const [acknowledged, setAcknowledged] = useState<typeof registration | null>(null);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    const schedule = (delayMs: number) => {
      if (!cancelled) timer = setTimeout(publish, delayMs);
    };
    function publish() {
      timer = null;
      // Serialize capability replacement across readiness/account transitions.
      // An older withdrawal must never arrive after a newer registration.
      publicationTail.current = publicationTail.current.then(async () => {
        if (cancelled) return;
        const attempt = { token: '' };
        try {
          const published = await withDeadline((async () => {
            const session = await loadSession();
            if (!session?.token || session.accountId !== accountId || cancelled) return false;
            attempt.token = session.token;
            await client.desktopAgentExecution(session.token, 'ready', { agentIds: JSON.parse(agentIdsKey) as string[], digest, scheduled, proactive });
            return true;
          })(), DESKTOP_READINESS_PUBLICATION_DEADLINE_MS, 'Desktop readiness did not finish in time.');
          if (published && !cancelled) setAcknowledged(registration);
          failures = 0;
          schedule(DESKTOP_READINESS_INTERVAL_MS);
        } catch (error) {
          if (cancelled) return;
          setAcknowledged(null);
          if (attempt.token && isCloudSessionRejected(error)) {
            // An expired or revoked session settles once: sign-in shows and
            // this loop stops until the person signs in again.
            reportWarning('[desktop-runtime] readiness stopped: session rejected', error);
            if (await endRejectedCloudSession(attempt.token).catch(() => false)) return;
            failures = 0;
            schedule(DESKTOP_READINESS_INTERVAL_MS);
            return;
          }
          failures += 1;
          reportWarning('[desktop-runtime] readiness failed', error);
          schedule(desktopReadinessRetryDelayMs(failures, error));
        }
      });
    }
    publish();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [accountId, agentIdsKey, client, digest, proactive, registration, reportWarning, scheduled]);

  // Presence alone does not grant a desktop execution lease. Admission must
  // wait until the server has accepted this account's current capabilities.
  return Boolean(accountId && runtimeReady && acknowledged === registration);
}
