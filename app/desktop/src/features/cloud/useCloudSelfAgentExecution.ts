import { voiceAgentText } from '@/features/chat/voiceTranscription';
import { useVoiceAgentRequestGate } from './useVoiceAgentRequestGate';
import { publishModelSubsessions } from './agentSubsessionSync';
import { useDesktopAgentReadiness, type CloudSelfAgentExecutionInput } from './useDesktopAgentReadiness';
import { cloudAgentBackgroundSessionsFromTurn } from './cloudAgentBackgroundSessions';
import {
  useCallback,
  useEffect,
  useRef,
} from 'react';
import { cloudSelfAgentExecutionContextMessages } from './cloudSelfAgentExecutionContext';
import {
  cancelDesktopChatTurn,
  startDesktopChatMessage,
} from '@/lib/desktop';
import type {
  DesktopChatTurnSnapshot,
} from '@/kordi-app/types';
import { resolveCloudMessageAttachments } from './cloudAttachments';
import {
  cloudAgentExecutionFingerprint,
  cloudAgentExecutionSnapshotFromTurn,
  finalizeCloudAgentExecutionSnapshot,
} from './cloudAgentExecutionTrace';
import {
  cloudAgentFailedTurnSnapshot,
  waitForCloudAgentTurn,
} from './cloudAgentLocalExecution';
import { cloudMessageIsSelfAgentRequest, parseCloudAgentResponse } from './cloudAgentMessages';
import { CloudAuthError } from './cloudAuthError';
import {
  cloudAgentRuntimeRouteAfterModelChange,
  cloudAgentRuntimeSessionId,
  cloudSelfAgentRuntimeSessionId,
  latestCloudAgentRuntimeRouteChangeBeforeRequest,
} from './cloudAgentRuntime';
import { cloudAgentRuntimeRouteForTargetCloudAgent } from './cloudAgentTargetRuntimeRoute';
import {
  cloudDirectMessageAgentRuntimeRoute,
  cloudDirectMessageContextMessages,
  cloudDirectMessageDisplayText,
  cloudDirectMessageTargetCloudAgentId,
} from './cloudDirectMessages';
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
import { closeCloudAgentRunFromDesktop } from './cloudInterruptedTurnRelease';
import {
  cloudSelfAgentInterruptedReply,
  cloudSelfAgentStoppedReply,
  cloudSelfAgentTerminalReply,
  settleCloudSelfAgentTerminalReply,
  settledCloudSelfAgentTurn,
  type CloudSelfAgentTerminalReply,
} from './cloudSelfAgentTerminalReply';
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

/** The text of the latest processing reply to `requestId`, as other devices saw it. */
function latestCloudSelfAgentProcessingText(
  requestId: string,
  messages: readonly { body: string; createdAt: string }[],
): string {
  let latest: { text: string; atMs: number } | null = null;
  for (const message of messages) {
    const response = parseCloudAgentResponse(message.body);
    if (response?.requestId !== requestId || response.deliveryState !== 'processing') continue;
    const atMs = Date.parse(message.createdAt) || 0;
    if (response.text.trim() && (!latest || atMs >= latest.atMs)) latest = { text: response.text, atMs };
  }
  return latest?.text ?? '';
}

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
  const activeRequestsRef = useRef(new Map<string, { sessionId: string; stop: () => void }>());
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
      const rememberLocalTurn = (turn: DesktopChatTurnSnapshot) => {
        if (turn.assistantText.trim()) {
          streamedTextByRequestIdRef.current.set(request.messageId, turn.assistantText);
        }
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

        const targetCloudAgentId =
          cloudDirectMessageTargetCloudAgentId(request.body)
          || cloudAgentSessionTargetFromMessages(
            selfMessages,
            account.accountId,
            request,
          )?.targetCloudAgentId
          || null;
        const executionRoute = cloudAgentRuntimeRouteForTargetCloudAgent({
          targetCloudAgentId,
          cloudAgentDefinitionsById,
          routesByRuntimeSessionId: effectiveRoutesBySessionId,
          runtimeSessionId: candidateRuntimeSessionId,
          fallbackRoute: defaultRoute,
          requestRoute,
        });
        const lease = await acquireDesktopExecutionLease(client, session.token, {
          requestMessageId: request.messageId, sessionId, ownerAccountId: account.accountId,
          requesterAccountId: account.accountId, prompt: (voice ? voiceAgentText(voice) : cloudDirectMessageDisplayText(request.body)),
          runtimeRoute: executionRoute ? { defaultModel: executionRoute.model, defaultAuthProvider: executionRoute.authProvider,
            defaultAuthChoice: executionRoute.authChoice, thinking: executionRoute.thinking } : undefined,
          idempotencyKey: `request:${request.messageId}`,
        });
        if (!lease) return;
        let stopRequested = false;
        const stop = () => {
          if (stopRequested) return;
          stopRequested = true;
          const turnId = turnIdsByRequestIdRef.current.get(request.messageId);
          if (!turnId) return;
          void cancelDesktopChatTurn(turnId).catch((error) => reportWarning(
            '[cloud-self-agent-execution] stop failed',
            error,
          ));
        };
        activeRequestsRef.current.set(request.messageId, { sessionId, stop });
        lease.onStopRequested(stop);
        const runtimeSessionId = cloudSelfAgentRuntimeSessionId(sessionId);
        let lastTurn: DesktopChatTurnSnapshot | null = null;
        let settled = false;
        // Every exit after the claim publishes a terminal reply and ends the
        // run in the same step, so other devices leave the running state.
        const settle = async (
          reply: CloudSelfAgentTerminalReply,
          options: {
            turn?: DesktopChatTurnSnapshot;
            publish?: boolean;
            execution?: ReturnType<typeof finalizeCloudAgentExecutionSnapshot>;
            backgroundSessions?: ReturnType<typeof cloudAgentBackgroundSessionsFromTurn>;
            clientMessageId?: string;
          } = {},
        ) => {
          settled = true;
          const response = await settleCloudSelfAgentTerminalReply({
            client,
            publisher: lease.publisher,
            token: session.token,
            accountId: account.accountId,
            sessionId,
            requestId: request.messageId,
            reply,
            execution: options.execution,
            backgroundSessions: options.backgroundSessions,
            clientMessageId: options.clientMessageId
              ?? `self-agent:${sessionId}:${request.messageId}:desktop-execution-response`,
            publish: options.publish,
            reportWarning,
          });
          const turn = options.turn ?? lastTurn;
          if (turn) rememberLocalTurn(settledCloudSelfAgentTurn(turn, reply));
          if (isInactive()) return;
          if (response) mergeMessage(response);
          await syncMessages().catch((error) => reportWarning(
            '[cloud-self-agent-execution] terminal sync failed',
            error,
          ));
        };
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

          if (!runtimeSessionId) {
            processedRequestIdsRef.current.delete(request.messageId);
            return;
          }
          const prompt = (voice ? voiceAgentText(voice) : cloudDirectMessageDisplayText(request.body)).trim();
          if (!prompt) {
            processedRequestIdsRef.current.delete(request.messageId);
            return;
          }
          const ownerName =
            account.displayName || account.primaryEmail || 'Me';
          const contextMessages = cloudSelfAgentExecutionContextMessages({
            definition: cloudAgentDefinitionsById?.[targetCloudAgentId ?? ''] ?? null,
            session: {
              messages: selfMessages,
              requestMessage: request,
              localAccountId: account.accountId,
              localHumanName: ownerName,
              peerHumanName: ownerName,
              localAgentName: account.defaultAgent?.displayName || 'Kordi',
              peerAgentName: account.defaultAgent?.displayName || 'Kordi',
            },
            requestContextMessages: cloudDirectMessageContextMessages(request.body),
          });

          let publishChain = Promise.resolve();
          let lastPublishedAtMs = 0;
          let lastFingerprint = '';
          let lastPublishedPhase: string | null = null;
          let revision = 0;
          const queueProgress = (turn: DesktopChatTurnSnapshot) => {
            lastTurn = turn;
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
                if (supersededRequestIdsRef.current.has(request.messageId) || stopRequested) {
                  // Nothing ran yet, so the reply is the short notice.
                  await settle(
                    stopRequested
                      ? cloudSelfAgentStoppedReply(null)
                      : { deliveryState: 'cancelled', text: 'Request canceled.' },
                    { turn: queuedTurn, clientMessageId: `request:${request.messageId}:cancelled` },
                  );
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
              executionRoute,
              lease.contextMessages(contextMessages),
              [],
              null,
              request.messageId,
              lease.deadline,
            );
            lease.attach(startedTurn.id);
            lastTurn = startedTurn;
            rememberLocalTurn(startedTurn);
            queueProgress(startedTurn);
            turnIdsByRequestIdRef.current.set(
              request.messageId,
              startedTurn.id,
            );
            if (stopRequested) {
              void cancelDesktopChatTurn(startedTurn.id).catch(() => undefined);
            }
            finalTurn = startedTurn.completed
              ? startedTurn
              : await waitForCloudAgentTurn(startedTurn.id, queueProgress);
            lastTurn = finalTurn;
            rememberLocalTurn(finalTurn);
          } catch (error) {
            finalTurn = {
              ...cloudAgentFailedTurnSnapshot({
                requestId: request.messageId,
                sessionId: runtimeSessionId,
                prompt,
                error,
              }),
              assistantText: lastTurn?.assistantText ?? '',
            };
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
          if (fallbackRun?.executionBackend !== 'desktop' && cloudAgentRunAlreadyOwnsRequest(fallbackRun)) {
            settled = true;
            return;
          }

          const reply = cloudSelfAgentTerminalReply({
            turn: finalTurn,
            streamedText: streamedTextByRequestIdRef.current.get(request.messageId),
            stopRequested,
            leaseLost: lease.lost,
          });
          const execution = finalizeCloudAgentExecutionSnapshot(
            cloudAgentExecutionSnapshotFromTurn(finalTurn),
            reply.deliveryState,
            finalTurn.completedAtMs ?? Date.now(),
          );
          void publishModelSubsessions(finalTurn).catch(() => undefined);
          // Another device may already have published the terminal reply; the
          // run still ends here.
          await settle(reply, {
            turn: finalTurn,
            publish: !cloudSelfAgentHasTerminalResponse(request.messageId, latestSnapshot),
            execution,
            backgroundSessions: cloudAgentBackgroundSessionsFromTurn(finalTurn),
          });
        } catch (error) {
          // A failure after the claim, such as a lost lease, still ends the
          // request with the text streamed so far.
          if (settled || isInactive()) throw error;
          reportWarning('[cloud-self-agent-execution] request failed', error);
          await settle(cloudSelfAgentInterruptedReply(
            streamedTextByRequestIdRef.current.get(request.messageId),
            error,
          ));
        } finally {
          activeRequestsRef.current.delete(request.messageId);
          streamedTextByRequestIdRef.current.delete(request.messageId);
          lease.dispose();
        }
      };
      processedRequestIdsRef.current.add(request.messageId);
      void executeRequest().catch((error) => {
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
  const stopActiveRequest = useCallback(async (sessionId: string): Promise<boolean> => {
    for (const active of activeRequestsRef.current.values()) {
      if (active.sessionId !== sessionId) continue;
      active.stop();
      return true;
    }
    const {
      account: currentAccount,
      client: currentClient,
      messageIndex: currentIndex,
      setLocalTurns: setCurrentLocalTurns,
      syncMessages: syncCurrentMessages,
      reportWarning: reportCurrentWarning,
    } = latestRef.current;
    if (!currentAccount) return false;
    const selfMessages = currentIndex.byPeerId.get(currentAccount.accountId) ?? [];
    // Oldest first: the running request precedes the ones queued behind it.
    // The server reports requests that already ended, so try the next one.
    const pending = selfMessages
      .filter((message) => (
        message.sessionId === sessionId
        && cloudMessageIsSelfAgentRequest(message, currentAccount)
        && !cloudSelfAgentHasTerminalResponse(message.messageId, selfMessages)
      ))
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
    if (pending.length === 0) return false;
    const session = await loadSession();
    if (!session?.token) throw new Error('Not signed in.');
    for (const request of pending) {
      const reply = cloudSelfAgentStoppedReply(
        streamedTextByRequestIdRef.current.get(request.messageId)
          || latestCloudSelfAgentProcessingText(request.messageId, selfMessages),
      );
      // This device's own run needs no live turn or lease to end.
      const closure = await closeCloudAgentRunFromDesktop(currentClient, session.token, {
        sessionId,
        requestId: request.messageId,
        state: 'cancelled',
        text: reply.text,
        ending: reply.ending,
      }).catch((error: unknown) => {
        if (!(error instanceof CloudAuthError) || ![404, 409].includes(error.status)) {
          reportCurrentWarning('[cloud-self-agent-execution] run close failed', error);
        }
        return null;
      });
      if (closure?.closed || closure?.published) {
        supersededRequestIdsRef.current.add(request.messageId);
        setCurrentLocalTurns((current) => {
          if (!current[request.messageId]) return current;
          const { [request.messageId]: _stopped, ...rest } = current;
          return rest;
        });
        await syncCurrentMessages().catch((error) => reportCurrentWarning(
          '[cloud-self-agent-execution] terminal sync failed',
          error,
        ));
        return true;
      }
      try {
        await currentClient.stopCloudAgentRequest(session.token, request.messageId);
        return true;
      } catch (error) {
        if (!(error instanceof CloudAuthError) || ![404, 409].includes(error.status)) throw error;
      }
    }
    return false;
  }, []);

  return { stopActiveRequest };
}
