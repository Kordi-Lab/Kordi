import { cloudAgentContextMessagesFromDefinition } from '@/features/chat/chatCreateFlows';
import { mergeCanonicalMessageRow } from '@/features/canonical/canonicalStateReducers';
import { isTerminalCloudAgentTurn } from '@/features/canonical/cloudAgentTurnLifecycle';
import {
  beginChatPerformanceSpan,
  finishChatPerformanceSpan,
} from '@/features/performance/chatPerformance';
import {
  cancelDesktopChatTurn,
  startDesktopSharedChatMessage,
  upsertCanonicalMessageFast,
} from '@/lib/desktop';
import type {
  AppendCanonicalMessageRequest,
  DesktopChatTurnSnapshot,
} from '@/kordi-app/types';
import { cloudGroupAgentCancelledNoticeRequest } from './cloudAgentCancellation';
import {
  cloudAgentNoProviderNoticeText,
  cloudAgentPublicBackgroundToolsFromTurn,
  isCloudAgentNoProviderConfiguredError,
  promptTextForCloudAgentMention,
} from './cloudAgentMessages';
import {
  cloudAgentRuntimeRouteForTargetCloudAgent,
} from './cloudAgentRuntime';
import type { ApplyCloudGroupAgentControlInput } from './cloudGroupAgentControl.types';
import {
  cloudGroupAgentGuardDecision,
  loadCloudGroupAgentTargetMessages,
} from './cloudGroupAgentGuard';
import { ensureCloudGroupAgentIdentity } from './cloudGroupAgentPersistence';
import {
  publishCloudGroupAgentEnvelope,
  publishCloudGroupAgentTerminalAfterGuards,
} from './cloudGroupAgentPublication';
import {
  cloudGroupAgentConversationId,
  cloudGroupAgentResponseTargetAccountIds,
  cloudGroupSelfParticipant,
  encodeCloudGroupControl,
} from './cloudGroupMessages';
import { cloudGroupAgentHandoffForResponse } from './cloudGroupMentions';
import type { IndexedCloudGroupRow } from './cloudMessageIndex';
import {
  cloudVisibleTaskRecordsForSession,
  mergeCloudSessionActivity,
} from './cloudSessionActivity';
import { loadSession } from './session';

export async function respondToCloudGroupAgentMention(
  input: ApplyCloudGroupAgentControlInput,
  groupRows: readonly IndexedCloudGroupRow[],
  runtimeSessionId: string,
  signal: AbortSignal,
): Promise<void> {
  const {
    context,
    setCanonicalState,
    runtime,
    policy,
  } = input;
  const {
    account,
    cloudMessage,
    envelope,
    groupSpaceId,
    mappedAttachments,
    participantByAccount,
  } = context;
  const message = envelope.message!;
  const session = await loadSession();
  if (!session?.token) throw new Error('Not signed in.');
  throwIfCloudAgentTurnAborted(signal);
  const targetAccountIds = cloudGroupAgentResponseTargetAccountIds({
    localAccountId: account.accountId,
    envelope,
    requestCloudMessage: cloudMessage,
  });
  const guardSpan = beginChatPerformanceSpan(
    'cloud-agent-ownership-guard',
  );
  const guardDecision = await cloudGroupAgentGuardDecision({
    loadMessages: () => loadCloudGroupAgentTargetMessages(
      runtime,
      session.token,
      targetAccountIds,
    ),
    fallbackOwnsRequest: () => policy.fallbackRunOwnsRequest({
      client: runtime.client,
      token: session.token,
      requestMessageId: message.id,
    }),
    responseExists: (messages) => policy.responseExists({
      localAccountId: account.accountId,
      requestMessageId: message.id,
      messages,
      groupRows,
      ignoreFailedCloudFallback: true,
    }),
  });
  finishChatPerformanceSpan(guardSpan, {
    resultClass: guardDecision.resultClass,
  });
  throwIfCloudAgentTurnAborted(signal);
  if (guardDecision.requestAlreadyOwned) {
    void runtime.syncDiff();
    return;
  }

  const presentation = await ensureCloudGroupAgentIdentity(input, signal);
  throwIfCloudAgentTurnAborted(signal);
  const processingMessageId =
    `msg:cloud-agent-processing:${message.id}:${account.accountId}`;
  const processingCreatedAtMs = Date.now();
  const processingRequest = {
    id: processingMessageId,
    sessionId: envelope.groupId,
    senderIdentityId: presentation.identityId,
    senderRole: 'owned-agent',
    messageKind: 'agent-turn',
    contentText: 'processing...',
    content: {
      sender: presentation.displayName,
      timestampMs: processingCreatedAtMs,
      deliveryState: 'processing',
      sourceConversationId: cloudGroupAgentConversationId(envelope.groupId),
      requestId: message.id,
      replyToMessageId: message.id,
    },
    createdAtMs: processingCreatedAtMs,
    parentMessageId: message.id,
    status: 'processing',
    sourceTransport: 'cloud-group-agent',
    sourceEventId: `cloud-group-agent:${processingMessageId}`,
  } satisfies AppendCanonicalMessageRequest;
  const persistedProcessingMessage = await upsertCanonicalMessageFast(
    processingRequest,
  );
  throwIfCloudAgentTurnAborted(signal);
  setCanonicalState((current) =>
    mergeCanonicalMessageRow(current, persistedProcessingMessage)
  );
  if (isTerminalCloudAgentTurn(persistedProcessingMessage)) {
    void runtime.syncDiff();
    return;
  }
  await publishCloudGroupAgentEnvelope({
    runtime,
    token: session.token,
    targetAccountIds,
    body: encodeCloudGroupControl({
      kind: 'group-message',
      groupId: envelope.groupId,
      groupSpaceId,
      groupTitle: null,
      createdByAccountId: envelope.createdByAccountId,
      actor: cloudGroupSelfParticipant(account, 'person'),
      participants: [...participantByAccount.values()],
      message: {
        id: processingMessageId,
        senderAccountId: account.accountId,
        text: 'processing...',
        createdAtMs: processingCreatedAtMs,
        senderKind: 'agent',
        senderDisplayName: presentation.displayName,
        deliveryState: 'processing',
        replyToMessageId: message.id,
        requestId: message.id,
      },
    }),
    sessionId: envelope.groupId,
    createdAtMs: processingCreatedAtMs,
    signal,
  });
  throwIfCloudAgentTurnAborted(signal);

  const contextMessages = [
    ...cloudAgentContextMessagesFromDefinition(
      runtime.agentDefinitionsById[message.targetCloudAgentId ?? ''] ?? null,
    ),
    ...policy.nativeContext({
      groupRows,
      groupId: envelope.groupId,
      requestMessageId: message.id,
      requestCreatedAtMs: message.createdAtMs,
      respondingAccountId: account.accountId,
    }),
  ];
  const rememberLocalTurn = (turn: DesktopChatTurnSnapshot) => {
    if (signal.aborted) return;
    runtime.setLocalTurns((current) => ({ ...current, [message.id]: turn }));
  };
  const runtimeStartSpan = beginChatPerformanceSpan(
    'cloud-agent-runtime-start',
  );
  let startedTurn: DesktopChatTurnSnapshot;
  try {
    startedTurn = await startDesktopSharedChatMessage(
      message.id,
      runtimeSessionId,
      promptTextForCloudAgentMention(message.text),
      mappedAttachments
        .map((attachment) => attachment.localPath?.trim() || '')
        .filter(Boolean),
      cloudAgentRuntimeRouteForTargetCloudAgent({
        targetCloudAgentId: message.targetCloudAgentId,
        cloudAgentDefinitionsById: runtime.agentDefinitionsById,
        routesByRuntimeSessionId: runtime.routesBySessionId,
        runtimeSessionId,
        fallbackRoute: runtime.defaultRoute,
        requestRoute: message.agentRuntimeRoute,
      }),
      contextMessages,
      cloudVisibleTaskRecordsForSession(
        runtime.sessionActivity(),
        envelope.groupId,
      ),
      envelope.groupId,
    );
    finishChatPerformanceSpan(runtimeStartSpan, { resultClass: 'success' });
  } catch (error) {
    finishChatPerformanceSpan(runtimeStartSpan, { resultClass: 'failed' });
    throw error;
  }
  rememberLocalTurn(startedTurn);
  runtime.turnIdsByRequestId.set(message.id, startedTurn.id);
  const cancelStartedTurn = () => {
    void cancelDesktopChatTurn(startedTurn.id).catch(() => undefined);
  };
  signal.addEventListener('abort', cancelStartedTurn, { once: true });
  if (signal.aborted) cancelStartedTurn();
  let finalTurn: DesktopChatTurnSnapshot;
  try {
    finalTurn = await waitForCloudGroupAgentTurn(
      startedTurn,
      rememberLocalTurn,
      (turnId, onSnapshot) => policy.waitForTurn(turnId, onSnapshot),
    );
  } finally {
    signal.removeEventListener('abort', cancelStartedTurn);
    runtime.turnIdsByRequestId.delete(message.id);
  }
  throwIfCloudAgentTurnAborted(signal);
  rememberLocalTurn(finalTurn);
  if (finalTurn.status === 'cancelled') {
    await persistCloudGroupAgentCancellation(
      input,
      persistedProcessingMessage,
    );
    return;
  }

  const succeeded = finalTurn.succeeded
    && finalTurn.assistantText.trim().length > 0;
  const responseText = succeeded ? finalTurn.assistantText.trim() : '';
  const failureMessage = succeeded
    ? null
    : isCloudAgentNoProviderConfiguredError(
        finalTurn.error || finalTurn.message,
      )
      ? cloudAgentNoProviderNoticeText()
      : finalTurn.error?.trim()
        || finalTurn.message?.trim()
        || 'Cloud agent returned no text response';
  const responseDeliveryState: 'complete' | 'failed' = succeeded
    ? 'complete'
    : 'failed';
  const responseMessageId = `msg:cloud-agent:${finalTurn.id}`;
  const responseCreatedAtMs = Date.now();
  const responseRequest = {
    ...processingRequest,
    contentText: responseText,
    content: {
      sender: presentation.displayName,
      timestampMs: responseCreatedAtMs,
      deliveryState: responseDeliveryState,
      cloudGroupMessageId: responseMessageId,
      sourceConversationId: cloudGroupAgentConversationId(envelope.groupId),
      requestId: message.id,
      replyToMessageId: message.id,
      ...(finalTurn.tools.length > 0 ? { tools: finalTurn.tools } : {}),
      ...(failureMessage ? { error: failureMessage } : {}),
    },
    createdAtMs: responseCreatedAtMs,
    status: responseDeliveryState,
    sourceEventId: `cloud-group-agent:${responseMessageId}`,
  } satisfies AppendCanonicalMessageRequest;
  const terminalUpsertSpan = beginChatPerformanceSpan(
    'cloud-agent-terminal-upsert',
  );
  let persistedResponseMessage;
  try {
    persistedResponseMessage = await upsertCanonicalMessageFast(
      responseRequest,
    );
    finishChatPerformanceSpan(terminalUpsertSpan, {
      resultClass: succeeded ? 'success' : 'failed',
    });
  } catch (error) {
    finishChatPerformanceSpan(terminalUpsertSpan, {
      resultClass: 'failed',
    });
    throw error;
  }
  throwIfCloudAgentTurnAborted(signal);
  clearCloudGroupAgentPendingState(
    input,
    persistedResponseMessage,
  );
  const agentHandoff = succeeded
    ? cloudGroupAgentHandoffForResponse({
      responseText,
      participants: envelope.participants,
      respondingAccountId: account.accountId,
      requestMessage: message,
    })
    : null;

  const activitySpan = beginChatPerformanceSpan(
    'cloud-agent-activity-publish',
  );
  void policy.publishActivity({
    client: runtime.client,
    token: session.token,
    accountId: account.accountId,
    sessionId: envelope.groupId,
    participantAccountIds: [...participantByAccount.keys()],
    participantProfiles: [...participantByAccount.values()].map(
      (participant) => ({
        accountId: participant.accountId,
        displayName: participant.displayName,
        avatarUrl: participant.avatarUrl,
        role: participant.role,
      }),
    ),
    turn: finalTurn,
    mergeActivity: (snapshot) => {
      if (signal.aborted) return;
      runtime.setSessionActivity(
        (current) => mergeCloudSessionActivity(current, snapshot),
      );
    },
  }).then(() => {
    finishChatPerformanceSpan(activitySpan, { resultClass: 'success' });
  }).catch((error) => {
    finishChatPerformanceSpan(activitySpan, { resultClass: 'failed' });
    runtime.reportFailure('local-response', error);
  });
  void publishCloudGroupAgentTerminalAfterGuards({
    context,
    runtime,
    policy,
    token: session.token,
    targetAccountIds,
    responseMessageId,
    responseCreatedAtMs,
    responseText: succeeded
      ? responseText
      : (failureMessage ?? ''),
    responseDeliveryState,
    responseTools: cloudAgentPublicBackgroundToolsFromTurn(finalTurn),
    agentDisplayName: presentation.displayName,
    agentHandoff,
    signal,
  }).catch((error) => runtime.reportFailure('local-response', error));
}

function throwIfCloudAgentTurnAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error('Cloud agent turn context changed.');
  }
}

async function waitForCloudGroupAgentTurn(
  startedTurn: DesktopChatTurnSnapshot,
  remember: (turn: DesktopChatTurnSnapshot) => void,
  waitForTurn: (
    turnId: string,
    onSnapshot?: (snapshot: DesktopChatTurnSnapshot) => void,
  ) => Promise<DesktopChatTurnSnapshot>,
) {
  const span = beginChatPerformanceSpan('cloud-agent-model-completion');
  try {
    const finalTurn = startedTurn.completed
      ? startedTurn
      : await waitForTurn(startedTurn.id, remember);
    finishChatPerformanceSpan(span, {
      resultClass: finalTurn.status === 'cancelled'
        ? 'cancelled'
        : finalTurn.succeeded
          ? 'success'
          : 'failed',
    });
    return finalTurn;
  } catch (error) {
    finishChatPerformanceSpan(span, { resultClass: 'failed' });
    throw error;
  }
}

async function persistCloudGroupAgentCancellation(
  input: ApplyCloudGroupAgentControlInput,
  processingMessage: Awaited<ReturnType<typeof upsertCanonicalMessageFast>>,
) {
  const { account, envelope } = input.context;
  const message = envelope.message!;
  const span = beginChatPerformanceSpan('cloud-agent-terminal-upsert');
  const request = cloudGroupAgentCancelledNoticeRequest({
    processingMessage,
    requestId: message.id,
    conversationId: cloudGroupAgentConversationId(envelope.groupId),
    cancelledByAccountId: account.accountId,
    cancelledByRole: 'agent owner',
    now: Date.now(),
  });
  try {
    const persisted = await upsertCanonicalMessageFast(request);
    clearCloudGroupAgentPendingState(input, persisted);
    finishChatPerformanceSpan(span, { resultClass: 'cancelled' });
  } catch (error) {
    finishChatPerformanceSpan(span, { resultClass: 'failed' });
    throw error;
  }
}

function clearCloudGroupAgentPendingState(
  input: ApplyCloudGroupAgentControlInput,
  terminalMessage: Awaited<ReturnType<typeof upsertCanonicalMessageFast>>,
) {
  const { account, envelope } = input.context;
  const message = envelope.message!;
  input.setCanonicalState((current) => {
    const withTerminal = mergeCanonicalMessageRow(current, terminalMessage);
    if (!withTerminal) return withTerminal;
    const withoutPending = input.stateOps.removePendingRows(
      withTerminal,
      message.id,
      account.accountId,
    ) ?? withTerminal;
    return input.stateOps.removeTimeoutPlaceholder(
      withoutPending,
      `msg:cloud-agent-offline:${message.id}:${account.accountId}`,
    ) ?? withoutPending;
  });
}
