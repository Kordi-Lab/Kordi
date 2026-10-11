import { useVoiceAgentRequestGate } from './useVoiceAgentRequestGate';
import { useDesktopAgentReadiness, type CloudSelfAgentExecutionInput } from './useDesktopAgentReadiness';
import {
  useCallback,
  useEffect,
  useRef,
} from 'react';
import { cancelDesktopChatTurn } from '@/lib/desktop';
import {
  cloudAgentRuntimeRouteAfterModelChange,
  cloudAgentRuntimeSessionId,
  cloudSelfAgentRuntimeSessionId,
  latestCloudAgentRuntimeRouteChangeBeforeRequest,
} from './cloudAgentRuntime';
import { cloudDirectMessageAgentRuntimeRoute } from './cloudDirectMessages';
import {
  cloudSelfAgentExecutionCanStart,
  cloudSelfAgentTerminalOrLocalRequestIds,
  omitTerminalCloudSelfAgentLocalTurns,
  pendingCloudSelfAgentExecutionRequests,
  localSelfAgentRequestClientMessageIds,
} from './cloudSelfAgentExecutionState';
import {
  executeCloudSelfAgentRequest,
  type CloudSelfAgentActiveRequest,
} from './cloudSelfAgentRequestExecution';
import { stopCloudSelfAgentRequest } from './cloudSelfAgentStopRequest';
export {
  cloudSelfAgentExecutionCanStart,
  cloudSelfAgentHasTerminalResponse,
  cloudSelfAgentTerminalOrLocalRequestIds,
  cloudSelfAgentTerminalResponseRequestIds,
  omitTerminalCloudSelfAgentLocalTurns,
  pendingCloudSelfAgentExecutionRequests,
  localSelfAgentRequestClientMessageIds,
} from './cloudSelfAgentExecutionState';

export function useCloudSelfAgentExecution({
  account,
  canonicalState,
  client,
  messageIndex,
  initialMessagesSettled,
  runtimeReady = true,
  routesBySessionId,
  defaultRoute,
  cloudAgentDefinitionsById,
  processedRequestIdsRef,
  turnIdsByRequestIdRef,
  setLocalTurns,
  mergeMessage,
  syncMessages,
  reportWarning,
}: CloudSelfAgentExecutionInput) {
  const supersededRequestIdsRef = useRef<Set<string>>(new Set());
  // Requests this Mac executes, by request message ID, with how to stop each.
  const activeRequestsRef = useRef(new Map<string, CloudSelfAgentActiveRequest>());
  // The answer text each request streamed so far, kept when the reply ends early.
  const streamedTextByRequestIdRef = useRef(new Map<string, string>());
  const latestRef = useRef({ account, client, messageIndex, setLocalTurns, syncMessages, reportWarning });
  useEffect(() => {
    latestRef.current = { account, client, messageIndex, setLocalTurns, syncMessages, reportWarning };
  }, [account, client, messageIndex, setLocalTurns, syncMessages, reportWarning]);
  const voiceGate = useVoiceAgentRequestGate();
  const executionReady = useDesktopAgentReadiness({ account, client, runtimeReady, cloudAgentDefinitionsById, reportWarning });
  const activeAccountIdRef = useRef<string | null>(
    account?.accountId ?? null,
  );
  useEffect(() => {
    const accountId = account?.accountId ?? null;
    activeAccountIdRef.current = accountId;
    return () => {
      if (activeAccountIdRef.current === accountId) {
        activeAccountIdRef.current = null;
      }
    };
  }, [account?.accountId]);

  useEffect(() => {
    if (!account) return;
    const selfMessages = messageIndex.byPeerId.get(account.accountId) ?? [];
    const terminalRequestIds = cloudSelfAgentTerminalOrLocalRequestIds(selfMessages, canonicalState);
    setLocalTurns((current) => omitTerminalCloudSelfAgentLocalTurns(
      current,
      terminalRequestIds,
    ));
    for (const requestId of terminalRequestIds) {
      const activeTurnId = turnIdsByRequestIdRef.current.get(requestId);
      supersededRequestIdsRef.current.add(requestId);
      turnIdsByRequestIdRef.current.delete(requestId);
      if (!activeTurnId) continue;
      void cancelDesktopChatTurn(activeTurnId).catch((error) => {
        reportWarning(
          '[cloud-self-agent-execution] superseded turn cancellation failed',
          error,
        );
      });
    }
  }, [
    account,
    canonicalState,
    messageIndex,
    reportWarning,
    setLocalTurns,
    turnIdsByRequestIdRef,
  ]);

  useEffect(() => {
    if (!cloudSelfAgentExecutionCanStart({
      account,
      initialMessagesSettled,
      runtimeReady: executionReady,
    })) return;
    if (!account) return;
    if (!canonicalState) return;
    const isInactive = () => (
      activeAccountIdRef.current !== account.accountId
    );
    const candidates = pendingCloudSelfAgentExecutionRequests({
      account,
      messageIndex,
      ignoredClientMessageIds:
        localSelfAgentRequestClientMessageIds(canonicalState),
    });
    const selfMessages =
      messageIndex.byPeerId.get(account.accountId) ?? [];
    for (const request of candidates) {
      if (processedRequestIdsRef.current.has(request.messageId)) continue;
      const voice = voiceGate.check(request);
      if (voice === undefined) continue;
      const candidateSessionId = request.sessionId?.trim() ?? '';
      const candidateRuntimeSessionId = cloudSelfAgentRuntimeSessionId(candidateSessionId);
      if (!candidateRuntimeSessionId) continue;
      const latestSessionRoute = latestCloudAgentRuntimeRouteChangeBeforeRequest(
        selfMessages,
        request,
      );
      const requestRoute = cloudDirectMessageAgentRuntimeRoute(request.body);
      const storedSessionRoute = routesBySessionId?.[candidateRuntimeSessionId]
        ?? routesBySessionId?.[cloudAgentRuntimeSessionId(account.accountId, candidateSessionId) ?? ''];
      // Every cross-device request carries the immutable route selected when
      // it was sent. A model-change notice is transcript/UI state and may be
      // delayed or absent after a definition refresh; it must never block the
      // executing Mac from starting the request.
      const eventConvergedSessionRoute = cloudAgentRuntimeRouteAfterModelChange(
        storedSessionRoute,
        latestSessionRoute,
        defaultRoute,
      );
      if (
        latestSessionRoute
        && !eventConvergedSessionRoute?.authChoice?.trim()
      ) {
        // Wait for the executing Mac to bind its local credential to the
        // newly synchronized session provider. The request remains pending
        // and this effect retries when the route state changes.
        continue;
      }
      const effectiveRoutesBySessionId = eventConvergedSessionRoute
        ? {
            ...routesBySessionId,
            [candidateRuntimeSessionId]: eventConvergedSessionRoute,
          }
        : routesBySessionId;
      processedRequestIdsRef.current.add(request.messageId);
      void executeCloudSelfAgentRequest({
        account,
        canonicalState,
        client,
        messageIndex,
        defaultRoute,
        cloudAgentDefinitionsById,
        processedRequestIdsRef,
        turnIdsByRequestIdRef,
        setLocalTurns,
        mergeMessage,
        syncMessages,
        reportWarning,
        request,
        voice,
        selfMessages,
        candidateRuntimeSessionId,
        effectiveRoutesBySessionId,
        requestRoute,
        isInactive,
        supersededRequestIdsRef,
        activeRequestsRef,
        streamedTextByRequestIdRef,
      }).catch((error) => {
        processedRequestIdsRef.current.delete(request.messageId);
        reportWarning('[cloud-self-agent-execution] request failed', error);
      });
    }
    return voiceGate.scheduleWake();
  }, [
    account,
    canonicalState,
    client,
    cloudAgentDefinitionsById,
    defaultRoute,
    initialMessagesSettled,
    mergeMessage,
    messageIndex,
    processedRequestIdsRef,
    reportWarning,
    routesBySessionId,
    executionReady,
    setLocalTurns,
    syncMessages,
    turnIdsByRequestIdRef,
    voiceGate,
  ]);

  /**
   * Stops the session's running request. A request this Mac executes stops
   * here. A request whose local turn is already gone, such as after a lost
   * lease, is ended through this device's run with the text it streamed.
   * Another executor learns of the stop from the server.
   */
  const stopActiveRequest = useCallback((sessionId: string): Promise<boolean> => stopCloudSelfAgentRequest({
    sessionId,
    activeRequests: activeRequestsRef.current,
    localTurnRequestIds: turnIdsByRequestIdRef.current,
    supersededRequestIds: supersededRequestIdsRef.current,
    streamedTextByRequestId: streamedTextByRequestIdRef.current,
    latest: latestRef.current,
  }), [turnIdsByRequestIdRef]);

  return { stopActiveRequest };
}