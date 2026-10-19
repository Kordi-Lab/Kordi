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
import { macCanRunDigest } from '@/features/digest/digestMacRuns';

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
  const readinessKey = JSON.stringify([accountId, agentIdsKey, digest, scheduled]);
  const registration = useMemo(() => ({ readinessKey, client }), [readinessKey, client]);
  const publicationTail = useRef(Promise.resolve());
  const [acknowledged, setAcknowledged] = useState<typeof registration | null>(null);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    let publishing = false;
    const publish = () => {
      if (publishing) return;
      publishing = true;
      // Serialize capability replacement across readiness/account transitions.
      // An older withdrawal must never arrive after a newer registration.
      publicationTail.current = publicationTail.current.then(async () => {
        try {
          if (cancelled) return;
          const session = await loadSession();
          if (!session?.token || session.accountId !== accountId || cancelled) return;
          await client.desktopAgentExecution(session.token, 'ready', { agentIds: JSON.parse(agentIdsKey) as string[], digest, scheduled });
          if (!cancelled) setAcknowledged(registration);
        } catch (error) {
          if (!cancelled) {
            setAcknowledged(null);
            reportWarning('[desktop-runtime] readiness failed', error);
          }
        } finally {
          publishing = false;
        }
      });
    };
    void publish();
    const timer = setInterval(() => { void publish(); }, 10_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [accountId, agentIdsKey, client, digest, registration, reportWarning, scheduled]);

  // Presence alone does not grant a desktop execution lease. Admission must
  // wait until the server has accepted this account's current capabilities.
  return Boolean(accountId && runtimeReady && acknowledged === registration);
}
