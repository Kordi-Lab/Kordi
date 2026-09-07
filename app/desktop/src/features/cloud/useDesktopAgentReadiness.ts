import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { CanonicalSessionState, DesktopChatTurnSnapshot } from '@/kordi-app/types';
import type { DesktopChatMessageRoute } from '@/lib/desktop';
import type { CloudAccount, CloudAuthClient, CloudMessage } from './authClient';
import type { CloudAgentDefinition } from './cloudAgents';
import type { CloudMessageIndex } from './cloudMessageIndex';
import { defaultCloudAgentId } from './cloudAgentIdentity';
import { loadSession } from './session';

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
};

export function useDesktopAgentReadiness({
  account, client, runtimeReady = true, cloudAgentDefinitionsById, reportWarning,
}: Pick<CloudSelfAgentExecutionInput, 'account' | 'client' | 'runtimeReady' | 'cloudAgentDefinitionsById' | 'reportWarning'>) {
  useEffect(() => {
    if (!account) return;
    let cancelled = false;
    const publish = async () => {
      const session = await loadSession();
      if (!session?.token || session.accountId !== account.accountId || cancelled) return;
      const agentIds = runtimeReady ? [defaultCloudAgentId(account.accountId), ...Object.values(cloudAgentDefinitionsById ?? {})
        .filter(agent => agent.ownerAccountId === account.accountId && agent.status !== 'archived').map(agent => agent.agentId)] : [];
      await client.desktopAgentExecution(session.token, 'ready', { agentIds });
    };
    void publish().catch(error => reportWarning('[desktop-runtime] readiness failed', error));
    const timer = setInterval(() => { void publish().catch(() => undefined); }, 10_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [account, client, runtimeReady, cloudAgentDefinitionsById, reportWarning]);
}
