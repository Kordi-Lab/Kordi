import {
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import { cloudAgentContextMessagesFromDefinition } from '@/features/chat/chatCreateFlows';
import {
  cancelDesktopChatTurn,
  startDesktopChatMessage,
  type DesktopChatMessageRoute,
} from '@/lib/desktop';
import type {
  CanonicalSessionState,
  DesktopChatTurnSnapshot,
} from '@/kordi-app/types';
import type {
  CloudAccount,
  CloudAuthClient,
  CloudMessage,
} from './authClient';
import type { CloudAgentDefinition } from './cloudAgents';
import { resolveCloudMessageAttachments } from './cloudAttachments';
import {
  cloudAgentExecutionFingerprint,
  cloudAgentExecutionSnapshotFromTurn,
  finalizeCloudAgentExecutionSnapshot,
} from './cloudAgentExecutionTrace';
import {
  cloudAgentFailedTurnSnapshot,
  cloudAgentLocalFailureMessage,
  waitForCloudAgentTurn,
} from './cloudAgentLocalExecution';
import {
  cloudAgentNativeContextMessagesFromDirectCloudSession,
  encodeCloudAgentResponse,
} from './cloudAgentMessages';
import {
  cloudAgentRuntimeRouteAfterModelChange,
  cloudAgentRuntimeRouteForTargetCloudAgent,
  cloudAgentRuntimeSessionId,
  cloudSelfAgentRuntimeSessionId,
  latestCloudAgentRuntimeRouteChangeBeforeRequest,
} from './cloudAgentRuntime';
import {
  cloudDirectMessageAgentRuntimeRoute,
  cloudDirectMessageDisplayText,
  cloudDirectMessageTargetCloudAgentId,
} from './cloudDirectMessages';
import type { CloudMessageIndex } from './cloudMessageIndex';
import { cloudAgentRunAlreadyOwnsRequest } from './cloudAgentRequestState';
import {
  CLOUD_SELF_AGENT_EXECUTION_STREAM_MS,
  CLOUD_SELF_AGENT_HEARTBEAT_MS,
  publishCloudSelfAgentExecutionSnapshot,
  publishCloudSelfAgentHeartbeat,
} from './cloudSelfAgentForwardExecution';
import { loadSession } from './session';
import {
  cloudSelfAgentExecutionCanStart,
  cloudSelfAgentHasTerminalResponse,
  cloudSelfAgentTerminalOrLocalRequestIds,
  omitTerminalCloudSelfAgentLocalTurns,
  pendingCloudSelfAgentExecutionRequests,
  localSelfAgentRequestClientMessageIds,
} from './cloudSelfAgentExecutionState';
import { cloudAgentSessionTargetFromMessages } from './cloudSelfAgentSessionIdentity';
import { acquireDesktopExecutionLease } from './cloudDesktopExecutionLease';
import { defaultCloudAgentId } from './cloudAgentIdentity';
import { planCloudSelfAgentCanonicalSync } from './cloudSelfAgentCanonicalSync';
import { persistCloudSelfAgentCanonicalSyncPlan } from './cloudSelfAgentCanonicalSyncExecution';
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
}: {
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
  setLocalTurns: Dispatch<
    SetStateAction<Record<string, DesktopChatTurnSnapshot>>
  >;
  mergeMessage: (message: CloudMessage) => void;
  syncMessages: () => Promise<void>;
  reportWarning: (message: string, error: unknown) => void;
}) {
  const supersededRequestIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!account) return;
    let cancelled = false;
    const publish = async () => {
      const session = await loadSession();
      if (!session?.token || cancelled) return;
      const agentIds = runtimeReady ? [defaultCloudAgentId(account.accountId), ...Object.values(cloudAgentDefinitionsById ?? {})
        .filter((agent) => agent.ownerAccountId === account.accountId && agent.status !== 'archived').map((agent) => agent.agentId)] : [];
      await client.desktopAgentExecution(session.token, 'ready', { agentIds });
    };
    void publish().catch((error) => reportWarning('[desktop-runtime] readiness failed', error));
    const timer = setInterval(() => { void publish().catch(() => undefined); }, 10_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [account, client, runtimeReady, cloudAgentDefinitionsById, reportWarning]);
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
      runtimeReady,
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
      const rememberLocalTurn = (turn: DesktopChatTurnSnapshot) => {
        if (
          isInactive()
          || supersededRequestIdsRef.current.has(request.messageId)
        ) return;
        setLocalTurns((current) => ({
          ...current,
          [request.messageId]: turn,
        }));
      };

      const executeRequest = async () => {
        const session = await loadSession();
        const sessionId = request.sessionId?.trim() ?? '';
        if (!session?.token || !sessionId || isInactive()) {
          processedRequestIdsRef.current.delete(request.messageId);
          return;
        }
        const existingRun = await client
          .lookupCloudAgentRunForRequest(session.token, request.messageId)
          .catch(() => null);
        if (cloudAgentRunAlreadyOwnsRequest(existingRun) || isInactive()) return;

        const lease = await acquireDesktopExecutionLease(client, session.token, {
          requestMessageId: request.messageId, sessionId, ownerAccountId: account.accountId,
          requesterAccountId: account.accountId, prompt: cloudDirectMessageDisplayText(request.body),
          runtimeRoute: requestRoute ? { defaultModel: requestRoute.model, defaultAuthProvider: requestRoute.authProvider,
            defaultAuthChoice: requestRoute.authChoice, thinking: requestRoute.thinking } : undefined,
          idempotencyKey: `request:${request.messageId}`,
        });
        if (!lease) return;
        try {
          if (isInactive()) return;
          const publisher = lease.publisher;
          await persistCloudSelfAgentCanonicalSyncPlan(planCloudSelfAgentCanonicalSync({
            account,
            messages: [request],
            state: canonicalState,
          }), { shouldContinue: () => !isInactive() });
          void syncMessages().catch((error) => reportWarning(
            '[cloud-self-agent-execution] claim sync failed',
            error,
          ));

          const runtimeSessionId = cloudSelfAgentRuntimeSessionId(sessionId);
          if (!runtimeSessionId) {
            processedRequestIdsRef.current.delete(request.messageId);
            return;
          }
          const prompt = cloudDirectMessageDisplayText(request.body).trim();
          if (!prompt) {
            processedRequestIdsRef.current.delete(request.messageId);
            return;
          }
          const targetCloudAgentId =
            cloudDirectMessageTargetCloudAgentId(request.body)
            || cloudAgentSessionTargetFromMessages(
              selfMessages,
              account.accountId,
              request,
            )?.targetCloudAgentId
            || null;
          const ownerName =
            account.displayName || account.primaryEmail || 'Me';
          const contextMessages = [
            ...cloudAgentContextMessagesFromDefinition(
              cloudAgentDefinitionsById?.[targetCloudAgentId ?? ''] ?? null,
            ),
            ...cloudAgentNativeContextMessagesFromDirectCloudSession({
              messages: selfMessages,
              requestMessage: request,
              localAccountId: account.accountId,
              localHumanName: ownerName,
              peerHumanName: ownerName,
              localAgentName: account.defaultAgent?.displayName || 'Kordi',
              peerAgentName: account.defaultAgent?.displayName || 'Kordi',
            }),
          ];

          let publishChain = Promise.resolve();
          let lastPublishedAtMs = 0;
          let lastFingerprint = '';
          let lastPublishedPhase: string | null = null;
          let revision = 0;
          const queueProgress = (turn: DesktopChatTurnSnapshot) => {
            rememberLocalTurn(turn);
            if (turn.completed || isInactive()) return;
            const execution = cloudAgentExecutionSnapshotFromTurn(turn);
            const fingerprint = cloudAgentExecutionFingerprint(
              execution,
              turn.assistantText,
            );
            const nowMs = Date.now();
            const changed = fingerprint !== lastFingerprint;
            const publishAfterMs = changed
              ? CLOUD_SELF_AGENT_EXECUTION_STREAM_MS
              : CLOUD_SELF_AGENT_HEARTBEAT_MS;
            const admissionChanged = lastPublishedPhase === null
              || (lastPublishedPhase === 'queued') !== (execution.phase === 'queued');
            if (!admissionChanged && nowMs - lastPublishedAtMs < publishAfterMs) return;
            lastPublishedAtMs = nowMs;
            lastFingerprint = fingerprint;
            lastPublishedPhase = execution.phase;
            revision += 1;
            const publishRevision = revision;
            publishChain = publishChain.then(async () => {
              if (isInactive()) return;
              const progress = changed
                ? await publishCloudSelfAgentExecutionSnapshot({
                    accountId: account.accountId,
                    assistantText: turn.assistantText,
                    client: publisher,
                    cloudRequestMessageId: request.messageId,
                    execution,
                    localRequestMessageId: request.messageId,
                    revision: publishRevision,
                    sessionId,
                    token: session.token,
                  })
                : await publishCloudSelfAgentHeartbeat({
                    accountId: account.accountId,
                    assistantText: turn.assistantText,
                    client: publisher,
                    cloudRequestMessageId: request.messageId,
                    execution,
                    localRequestMessageId: request.messageId,
                    nowMs,
                    sessionId,
                    token: session.token,
                  });
              if (isInactive()) return;
              mergeMessage(progress);
              await syncMessages();
            }).catch((error) => {
              reportWarning(
                '[cloud-self-agent-execution] progress publish failed',
                error,
              );
            });
          };

          let finalTurn: DesktopChatTurnSnapshot;
          try {
            if (!await lease.admitted()) {
              const queuedTurn: DesktopChatTurnSnapshot = {
                id: `queued:${request.messageId}`, sessionId: runtimeSessionId, prompt,
                status: 'queued', message: 'Queued next', assistantText: '', thinkingText: '', tools: [],
                completed: false, succeeded: false, startedAtMs: Date.now(), replyToMessageId: request.messageId,
              };
              queueProgress(queuedTurn);
              await publishChain;
              do {
                await new Promise((resolve) => setTimeout(resolve, 1000));
                if (isInactive()) return;
                if (supersededRequestIdsRef.current.has(request.messageId)) {
                  const cancelled = await publisher.sendMessage(session.token, account.accountId,
                    encodeCloudAgentResponse({ requestId: request.messageId, text: 'Request canceled.', deliveryState: 'cancelled' }),
                    { clientMessageId: `request:${request.messageId}:cancelled` });
                  mergeMessage(cancelled);
                  return;
                }
              } while (!await lease.admitted());
            }
            const agentAttachments = request.attachments?.length
              ? await resolveCloudMessageAttachments({
                  token: session.token,
                  client,
                  attachments: request.attachments,
                })
              : request.attachments ?? [];
            const startedTurn = await startDesktopChatMessage(
              runtimeSessionId,
              prompt,
              agentAttachments
                .map((attachment) => attachment.localPath?.trim() || '')
                .filter(Boolean),
              cloudAgentRuntimeRouteForTargetCloudAgent({
                targetCloudAgentId,
                cloudAgentDefinitionsById,
                routesByRuntimeSessionId: effectiveRoutesBySessionId,
                runtimeSessionId,
                fallbackRoute: defaultRoute,
                requestRoute,
              }),
              contextMessages,
              [],
              null,
              request.messageId,
              lease.deadline,
            );
            lease.attach(startedTurn.id);
            rememberLocalTurn(startedTurn);
            queueProgress(startedTurn);
            turnIdsByRequestIdRef.current.set(
              request.messageId,
              startedTurn.id,
            );
            finalTurn = startedTurn.completed
              ? startedTurn
              : await waitForCloudAgentTurn(startedTurn.id, queueProgress);
            rememberLocalTurn(finalTurn);
          } catch (error) {
            finalTurn = cloudAgentFailedTurnSnapshot({
              requestId: request.messageId,
              sessionId: runtimeSessionId,
              prompt,
              error,
            });
            rememberLocalTurn(finalTurn);
            reportWarning(
              '[cloud-self-agent-execution] local response failed',
              error,
            );
          } finally {
            turnIdsByRequestIdRef.current.delete(request.messageId);
          }

          await publishChain;
          if (isInactive()) return;
          const [latestSnapshot, fallbackRun] = await Promise.all([
            client.listMessageSnapshot(session.token, account.accountId, 100)
              .then((snapshot) => snapshot.messages)
              .catch(() => messageIndex.byPeerId.get(account.accountId) ?? []),
            client.lookupCloudAgentRunForRequest(
              session.token,
              request.messageId,
            ).catch(() => null),
          ] as const);
          if (
            cloudSelfAgentHasTerminalResponse(
              request.messageId,
              latestSnapshot,
            )
            || (fallbackRun?.executionBackend !== 'desktop' && cloudAgentRunAlreadyOwnsRequest(fallbackRun))
          ) return;

          const succeeded = finalTurn.succeeded
            && finalTurn.assistantText.trim().length > 0;
          const deliveryState = finalTurn.status === 'cancelled'
            ? 'cancelled' as const
            : succeeded
              ? 'complete' as const
              : 'failed' as const;
          const responseText = succeeded
            ? finalTurn.assistantText.trim()
            : finalTurn.status === 'cancelled'
              ? 'Request stopped.'
              : cloudAgentLocalFailureMessage(
                finalTurn.error || finalTurn.message,
              );
          const execution = finalizeCloudAgentExecutionSnapshot(
            cloudAgentExecutionSnapshotFromTurn(finalTurn),
            deliveryState,
            finalTurn.completedAtMs ?? Date.now(),
          );
          const response = await publisher.sendMessage(
            session.token,
            account.accountId,
            encodeCloudAgentResponse({
              requestId: request.messageId,
              text: responseText,
              deliveryState,
              execution,
            }),
            {
              sessionId,
              clientMessageId:
                `self-agent:${sessionId}:${request.messageId}`
                + ':desktop-execution-response',
            },
          );
          if (isInactive()) return;
          mergeMessage(response);
          await syncMessages();
        } finally { lease.dispose(); }
      };
      processedRequestIdsRef.current.add(request.messageId);
      void executeRequest().catch((error) => {
        processedRequestIdsRef.current.delete(request.messageId);
        reportWarning('[cloud-self-agent-execution] request failed', error);
      });
    }
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
    runtimeReady,
    setLocalTurns,
    syncMessages,
    turnIdsByRequestIdRef,
  ]);
}
