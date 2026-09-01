import { upsertCanonicalMessageFast } from '@/lib/desktop';
import type {
  AppendCanonicalMessageRequest,
  CanonicalSessionState,
  MessageActionMetadata,
} from '@/kordi-app/types';
import { mergeCanonicalMessageRow } from '@/features/canonical/canonicalStateReducers';
import {
  beginChatPerformanceSpan,
  finishChatPerformanceSpan,
} from '@/features/performance/chatPerformance';
import {
  cloudAgentNoProviderNoticeText,
  isCloudAgentNoProviderConfiguredError,
} from './cloudAgentMessages';
import {
  cloudGroupAgentConversationId,
  cloudGroupAgentResponseTargetAccountIds,
  cloudGroupSelfParticipant,
  encodeCloudGroupControl,
} from './cloudGroupMessages';
import { loadSession } from './session';
import { cloudAgentLocalFailureMessage } from './cloudAgentLocalExecution';
import {
  cloudAgentCanonicalIdentityId,
  cloudAgentDisplayName,
  cloudAgentId,
} from './cloudAgentIdentity';
import type {
  CanonicalSessionStateSetter,
  CloudGroupAgentRuntime,
  CloudGroupMessageControlContext,
} from './cloudGroupControlContext';

type CloudGroupAgentFailureStateOps = {
  cleanText(value?: string | null): string;
  removePendingRows(
    current: CanonicalSessionState | null,
    requestId: string,
    targetAccountId: string,
  ): CanonicalSessionState | null;
  removeTimeoutPlaceholder(
    current: CanonicalSessionState | null,
    noticeId: string,
  ): CanonicalSessionState | null;
};

export type HandleCloudGroupAgentFailureInput = {
  context: CloudGroupMessageControlContext;
  setCanonicalState: CanonicalSessionStateSetter;
  runtime: CloudGroupAgentRuntime;
  stateOps: CloudGroupAgentFailureStateOps;
  signal?: AbortSignal;
};

export function cloudGroupAgentFailureNoticeRequest({
  accountId,
  agentId,
  groupId,
  requestId,
  agentDisplayName,
  ownerDisplayName,
  error,
  messageAction = null,
  now = Date.now(),
}: {
  accountId: string;
  agentId?: string | null;
  groupId: string;
  requestId: string;
  agentDisplayName: string;
  ownerDisplayName?: string | null;
  error: unknown;
  messageAction?: MessageActionMetadata | null;
  now?: number;
}): AppendCanonicalMessageRequest {
  const noProvider = isCloudAgentNoProviderConfiguredError(error);
  const failureText = noProvider
    ? cloudAgentNoProviderNoticeText()
    : cloudAgentLocalFailureMessage(error);
  const processingMessageId =
    `msg:cloud-agent-processing:${requestId}:${accountId}`;
  return {
    id: processingMessageId,
    sessionId: groupId,
    senderIdentityId: cloudAgentCanonicalIdentityId(agentId, accountId),
    senderRole: 'owned-agent',
    messageKind: 'agent-turn',
    contentText: '',
    content: {
      sender: agentDisplayName,
      senderOwnerAccountId: accountId,
      senderOwnerName: ownerDisplayName?.trim() || null,
      timestampMs: now,
      deliveryState: 'failed',
      sourceConversationId: cloudGroupAgentConversationId(groupId),
      requestId,
      replyToMessageId: requestId,
      ...(messageAction?.kind === 'thread' ? { messageAction } : {}),
      error: failureText,
    },
    createdAtMs: now,
    parentMessageId: requestId,
    status: 'failed',
    sourceTransport: 'cloud-group-agent',
    sourceEventId: noProvider
      ? `cloud-group-agent-no-provider:${requestId}:${accountId}`
      : `cloud-group-agent-failed:${requestId}:${accountId}`,
  };
}

export async function handleCloudGroupAgentFailure(
  error: unknown,
  {
    context,
    setCanonicalState,
    runtime,
    stateOps,
    signal,
  }: HandleCloudGroupAgentFailureInput,
): Promise<void> {
  const { account, envelope } = context;
  const message = envelope.message;
  if (!message) return;
  runtime.turnIdsByRequestId.delete(message.id);

  const responseCreatedAtMs = Date.now();
  const noProvider = isCloudAgentNoProviderConfiguredError(error);
  const responseMessageId = noProvider
    ? `msg:cloud-agent-no-provider:${message.id}:${account.accountId}`
    : `msg:cloud-agent-failed:${message.id}:${account.accountId}`;
  const hostedAgentName = stateOps.cleanText(message.targetCloudAgentName);
  const hostedAgentOwnerName = stateOps.cleanText(message.targetCloudAgentOwnerName)
    || stateOps.cleanText(account.displayName)
    || stateOps.cleanText(account.primaryEmail)
    || 'Cloud user';
  const agentId = cloudAgentId(message.targetCloudAgentId, account.accountId);
  const agentDisplayName = cloudAgentDisplayName(hostedAgentName);
  const failureText = noProvider
    ? cloudAgentNoProviderNoticeText()
    : cloudAgentLocalFailureMessage(error);
  const failedResponseRequest = cloudGroupAgentFailureNoticeRequest({
    accountId: account.accountId,
    agentId,
    groupId: envelope.groupId,
    requestId: message.id,
    agentDisplayName,
    ownerDisplayName: hostedAgentOwnerName,
    error,
    messageAction: message.messageAction,
    now: responseCreatedAtMs,
  });
  const terminalUpsertSpan = beginChatPerformanceSpan(
    'cloud-agent-terminal-upsert',
  );
  let persistedResponse;
  try {
    persistedResponse = await upsertCanonicalMessageFast(
      failedResponseRequest,
    );
    finishChatPerformanceSpan(terminalUpsertSpan, {
      resultClass: 'failed',
    });
  } catch (persistError) {
    finishChatPerformanceSpan(terminalUpsertSpan, {
      resultClass: 'failed',
    });
    throw persistError;
  }
  if (signal?.aborted) return;
  const offlinePlaceholderId =
    `msg:cloud-agent-offline:${message.id}:${account.accountId}`;
  setCanonicalState((current) => {
    const withFailure = mergeCanonicalMessageRow(current, persistedResponse);
    if (!withFailure) return withFailure;
    const withoutPending = stateOps.removePendingRows(
      withFailure,
      message.id,
      account.accountId,
    ) ?? withFailure;
    return stateOps.removeTimeoutPlaceholder(
      withoutPending,
      offlinePlaceholderId,
    ) ?? withoutPending;
  });
  if (!noProvider) runtime.reportFailure('local-response', error);

  void publishCloudGroupAgentFailure({
    context,
    runtime,
    responseMessageId,
    responseCreatedAtMs,
    failureText,
    agentDisplayName,
    agentId,
    signal,
  }).catch((fanoutError) => {
    runtime.reportFailure(
      noProvider ? 'no-provider-notice' : 'local-response',
      fanoutError,
    );
  });
}

async function publishCloudGroupAgentFailure({
  context,
  runtime,
  responseMessageId,
  responseCreatedAtMs,
  failureText,
  agentDisplayName,
  agentId,
  signal,
}: {
  context: CloudGroupMessageControlContext;
  runtime: CloudGroupAgentRuntime;
  responseMessageId: string;
  responseCreatedAtMs: number;
  failureText: string;
  agentDisplayName: string;
  agentId: string;
  signal?: AbortSignal;
}): Promise<void> {
  if (signal?.aborted) return;
  const {
    account,
    cloudMessage,
    envelope,
    groupSpaceId,
    participantByAccount,
  } = context;
  const message = envelope.message!;

  const session = await loadSession();
  if (!session?.token) return;
  const targetAccountIds = cloudGroupAgentResponseTargetAccountIds({
    localAccountId: account.accountId,
    envelope,
    requestCloudMessage: cloudMessage,
  });
  const responseBody = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: envelope.groupId,
    groupSpaceId,
    groupTitle: null,
    createdByAccountId: envelope.createdByAccountId,
    actor: cloudGroupSelfParticipant(account, 'person'),
    participants: [...participantByAccount.values()],
    message: {
      id: responseMessageId,
      senderAccountId: account.accountId,
      senderAgentId: agentId,
      text: failureText,
      createdAtMs: responseCreatedAtMs,
      senderKind: 'agent',
      senderDisplayName: agentDisplayName,
      deliveryState: 'failed',
      replyToMessageId: message.id,
      requestId: message.id,
      ...(message.messageAction?.kind === 'thread' ? { messageAction: message.messageAction } : {}),
    },
  });
  const fanoutSpan = beginChatPerformanceSpan(
    'cloud-agent-terminal-fanout',
  );
  const sent = await Promise.allSettled(
    targetAccountIds.map((targetAccountId) => runtime.client.sendMessage(
      session.token,
      targetAccountId,
      responseBody,
      {
        sessionId: envelope.groupId,
        clientCreatedAt: new Date(responseCreatedAtMs).toISOString(),
        conversationKind: 'group',
        memberAccountIds: targetAccountIds,
      },
    )),
  );
  sent.forEach((result) => {
    if (result.status === 'fulfilled' && !signal?.aborted) {
      runtime.mergeMessage(result.value);
    }
  });
  const fanoutFailure = sent.find(
    (result): result is PromiseRejectedResult =>
      result.status === 'rejected',
  );
  const sentCount = sent.filter(
    (result) => result.status === 'fulfilled',
  ).length;
  const failedCount = sent.length - sentCount;
  finishChatPerformanceSpan(fanoutSpan, {
    resultClass: failedCount === 0
      ? 'success'
      : sentCount > 0
        ? 'partial'
        : 'failed',
    recipientCount: targetAccountIds.length,
    errorCount: failedCount,
  });
  if (!signal?.aborted) void runtime.syncDiff();
  if (fanoutFailure) throw fanoutFailure.reason;
}
