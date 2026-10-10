import { voiceAgentText } from '@/features/chat/voiceTranscription';
import type { CanonicalSessionState, DesktopChatTurnSnapshot } from '@/kordi-app/types';
import { cancelDesktopChatTurn, startDesktopChatMessage } from '@/lib/desktop';
import { publishModelSubsessions } from './agentSubsessionSync';
import type { CloudAccount, CloudMessage } from './authClient';
import { resolveCloudMessageAttachments } from './cloudAttachments';
import { cloudAgentBackgroundSessionsFromTurn } from './cloudAgentBackgroundSessions';
import {
  cloudAgentExecutionFingerprint,
  cloudAgentExecutionSnapshotFromTurn,
  finalizeCloudAgentExecutionSnapshot,
} from './cloudAgentExecutionTrace';
import {
  cloudAgentFailedTurnSnapshot,
  waitForCloudAgentTurn,
} from './cloudAgentLocalExecution';
import { cloudAgentRunAlreadyOwnsRequest } from './cloudAgentRequestState';
import { cloudSelfAgentRuntimeSessionId } from './cloudAgentRuntime';
import { cloudAgentRuntimeRouteForTargetCloudAgent } from './cloudAgentTargetRuntimeRoute';
import { acquireDesktopExecutionLease } from './cloudDesktopExecutionLease';
import {
  cloudDirectMessageAgentRuntimeRoute,
  cloudDirectMessageContextMessages,
  cloudDirectMessageDisplayText,
  cloudDirectMessageTargetCloudAgentId,
} from './cloudDirectMessages';
import { planCloudSelfAgentCanonicalSync } from './cloudSelfAgentCanonicalSync';
import { persistCloudSelfAgentCanonicalSyncPlan } from './cloudSelfAgentCanonicalSyncExecution';
import { cloudSelfAgentExecutionContextMessages } from './cloudSelfAgentExecutionContext';
import { cloudSelfAgentHasTerminalResponse } from './cloudSelfAgentExecutionState';
import {
  CLOUD_SELF_AGENT_EXECUTION_STREAM_MS,
  CLOUD_SELF_AGENT_HEARTBEAT_MS,
  publishCloudSelfAgentExecutionSnapshot,
  publishCloudSelfAgentHeartbeat,
} from './cloudSelfAgentForwardExecution';
import { cloudAgentSessionTargetFromMessages } from './cloudSelfAgentSessionIdentity';
import {
  cloudSelfAgentInterruptedReply,
  cloudSelfAgentStoppedReply,
  cloudSelfAgentTerminalReply,
  settleCloudSelfAgentTerminalReply,
  settledCloudSelfAgentTurn,
  type CloudSelfAgentTerminalReply,
} from './cloudSelfAgentTerminalReply';
import { loadSession } from './session';
import type { CloudSelfAgentExecutionInput } from './useDesktopAgentReadiness';

/** A request this Mac executes, with the session it belongs to and how to stop it. */
export type CloudSelfAgentActiveRequest = { sessionId: string; stop: () => void };

export type CloudSelfAgentRequestExecutionInput = Pick<
  CloudSelfAgentExecutionInput,
  | 'client'
  | 'messageIndex'
  | 'defaultRoute'
  | 'cloudAgentDefinitionsById'
  | 'processedRequestIdsRef'
  | 'turnIdsByRequestIdRef'
  | 'setLocalTurns'
  | 'mergeMessage'
  | 'syncMessages'
  | 'reportWarning'
> & {
  account: CloudAccount;
  canonicalState: CanonicalSessionState;
  request: CloudMessage;
  voice: CloudMessage['voiceMessage'];
  selfMessages: readonly CloudMessage[];
  candidateRuntimeSessionId: string;
  effectiveRoutesBySessionId: CloudSelfAgentExecutionInput['routesBySessionId'];
  requestRoute: ReturnType<typeof cloudDirectMessageAgentRuntimeRoute>;
  isInactive: () => boolean;
  supersededRequestIdsRef: { readonly current: Set<string> };
  activeRequestsRef: { readonly current: Map<string, CloudSelfAgentActiveRequest> };
  streamedTextByRequestIdRef: { readonly current: Map<string, string> };
};

/**
 * Executes one cross-device self-agent request on this Mac: claims the
 * execution lease, runs the local turn, publishes progress, and settles the
 * terminal reply so the run ends on every device.
 */
export async function executeCloudSelfAgentRequest({
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
}: CloudSelfAgentRequestExecutionInput): Promise<void> {
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
}
