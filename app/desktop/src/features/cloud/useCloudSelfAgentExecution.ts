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
import type { DesktopChatTurnSnapshot } from '@/kordi-app/types';
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
  type CloudAgentExecutionSnapshot,
} from './cloudAgentMessages';
import {
  cloudAgentRuntimeRouteAfterModelChange,
  cloudAgentRuntimeRouteForTargetCloudAgent,
  cloudAgentRuntimeSessionId,
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
  publishCloudSelfAgentExecutionClaim,
  publishCloudSelfAgentExecutionSnapshot,
  publishCloudSelfAgentHeartbeat,
} from './cloudSelfAgentForwardExecution';
import { loadSession } from './session';
import {
  cloudSelfAgentExecutionCanStart,
  cloudSelfAgentHasTerminalResponse,
  cloudSelfAgentTerminalResponseRequestIds,
  omitTerminalCloudSelfAgentLocalTurns,
  pendingCloudSelfAgentExecutionRequests,
} from './cloudSelfAgentExecutionState';
import { cloudAgentSessionTargetFromMessages } from './cloudSelfAgentSessionIdentity';

export {
  cloudSelfAgentExecutionCanStart,
  cloudSelfAgentHasTerminalResponse,
  cloudSelfAgentTerminalResponseRequestIds,
  omitTerminalCloudSelfAgentLocalTurns,
  pendingCloudSelfAgentExecutionRequests,
} from './cloudSelfAgentExecutionState';

function preparingExecutionSnapshot(nowMs = Date.now()): CloudAgentExecutionSnapshot {
  return {
    phase: 'preparing',
    summary: 'Preparing the response',
    steps: [],
    startedAtMs: nowMs,
    updatedAtMs: nowMs,
    completed: false,
  };
}

export function useCloudSelfAgentExecution({
  account,
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
    const terminalRequestIds = cloudSelfAgentTerminalResponseRequestIds(
      selfMessages,
    );
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
    const isInactive = () => (
      activeAccountIdRef.current !== account.accountId
    );
    const candidates = pendingCloudSelfAgentExecutionRequests({
      account,
      messageIndex,
    });
    const selfMessages =
      messageIndex.byPeerId.get(account.accountId) ?? [];
    for (const request of candidates) {
      if (processedRequestIdsRef.current.has(request.messageId)) continue;
      const candidateSessionId = request.sessionId?.trim() ?? '';
      const candidateRuntimeSessionId = cloudAgentRuntimeSessionId(
        account.accountId,
        candidateSessionId,
      );
      if (!candidateRuntimeSessionId) continue;
      const latestSessionRoute = latestCloudAgentRuntimeRouteChangeBeforeRequest(
        selfMessages,
        request,
      );
      const requestRoute = cloudDirectMessageAgentRuntimeRoute(request.body);
      const storedSessionRoute = routesBySessionId?.[candidateRuntimeSessionId];
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

      void (async () => {
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

        const claimId = crypto.randomUUID();
        const claim = await publishCloudSelfAgentExecutionClaim({
          accountId: account.accountId,
          claimId,
          client,
          cloudRequestMessageId: request.messageId,
          execution: preparingExecutionSnapshot(),
          sessionId,
          token: session.token,
        });
        mergeMessage(claim.message);
        await syncMessages();
        if (!claim.acquired || isInactive()) return;

        const runtimeSessionId = cloudAgentRuntimeSessionId(
          account.accountId,
          sessionId,
        );
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
            localAgentName: 'My Kordi',
            peerAgentName: 'My Kordi',
          }),
        ];

        let publishChain = Promise.resolve();
        let lastPublishedAtMs = Date.now();
        let lastFingerprint = '';
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
          if (nowMs - lastPublishedAtMs < publishAfterMs) return;
          lastPublishedAtMs = nowMs;
          lastFingerprint = fingerprint;
          revision += 1;
          const publishRevision = revision;
          publishChain = publishChain.then(async () => {
            if (isInactive()) return;
            const progress = changed
              ? await publishCloudSelfAgentExecutionSnapshot({
                  accountId: account.accountId,
                  assistantText: turn.assistantText,
                  client,
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
                  client,
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
          );
          rememberLocalTurn(startedTurn);
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
          || cloudAgentRunAlreadyOwnsRequest(fallbackRun)
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
        const response = await client.sendMessage(
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
      })().catch((error) => {
        processedRequestIdsRef.current.delete(request.messageId);
        reportWarning(
          '[cloud-self-agent-execution] request failed',
          error,
        );
      });
    }
  }, [
    account,
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
