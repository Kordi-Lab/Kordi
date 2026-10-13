import { useEffect, useRef } from 'react';
import type { CloudAccount, CloudAuthClient } from '@/features/cloud/authClient';
import type { CloudAgentDefinition } from '@/features/cloud/cloudAgents';
import type { DesktopChatMessageRoute } from '@/lib/desktop';
import {
  runDocumentAgentRequest,
  setDocumentAgentRequestHandler,
  type DocumentAgentRuntime,
} from './documentAgentRequests';

/** Runs comment requests for this account's agents on this Mac while its runtime is ready. */
export function useDocumentAgentRequests({
  account,
  client,
  agentDefinitionsById,
  routesBySessionId,
  defaultRoute,
  runtimeReady,
  reportWarning,
}: {
  account: CloudAccount | null;
  client: CloudAuthClient;
  agentDefinitionsById: Record<string, CloudAgentDefinition>;
  routesBySessionId?: Record<string, DesktopChatMessageRoute>;
  defaultRoute?: DesktopChatMessageRoute | null;
  runtimeReady: boolean;
  reportWarning: (message: string, error: unknown) => void;
}) {
  const accountId = account?.accountId ?? null;
  const runtimeRef = useRef<DocumentAgentRuntime | null>(null);
  useEffect(() => {
    runtimeRef.current = accountId
      ? { accountId, client, agentDefinitionsById, routesBySessionId, defaultRoute, reportWarning }
      : null;
  }, [accountId, agentDefinitionsById, client, defaultRoute, reportWarning, routesBySessionId]);
  useEffect(() => {
    if (!accountId || !runtimeReady) return;
    setDocumentAgentRequestHandler((request) => {
      const runtime = runtimeRef.current;
      if (runtime) void runDocumentAgentRequest(request, runtime);
    });
    return () => setDocumentAgentRequestHandler(null);
  }, [accountId, runtimeReady]);
}
