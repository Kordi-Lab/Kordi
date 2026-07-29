import { cloudAgentContextMessagesFromDefinition } from '@/features/chat/chatCreateFlows';
import {
  startDesktopChatMessage,
  upsertCanonicalIdentityFast,
  upsertCanonicalMessageFast,
  type DesktopChatContextMessage,
} from '@/lib/desktop';
import type {
  AppendCanonicalMessageRequest,
  CanonicalIdentity,
  CanonicalSessionState,
  DesktopChatTurnSnapshot,
} from '@/kordi-app/types';
import {
  CLOUD_AGENT_RUNTIME_SESSION_PREFIX,
  cloudAgentNoProviderNoticeText,
  isCloudAgentNoProviderConfiguredError,
  promptTextForCloudAgentMention,
} from './cloudAgentMessages';
import { cloudAgentRuntimeRouteForTargetCloudAgent } from './cloudAgentRuntime';
import {
  cloudGroupAgentConversationId,
  cloudGroupAgentResponseTargetAccountIds,
  cloudGroupLocalAgentRequestAlreadyHandled,
  cloudGroupSelfParticipant,
  encodeCloudGroupControl,
} from './cloudGroupMessages';
import {
  cloudVisibleTaskRecordsForSession,
  mergeCloudSessionActivity,
  type CloudActivityParticipantProfile,
  type CloudSessionActivityStore,
} from './cloudSessionActivity';
import type { CloudMessage } from './authClient';
import type { IndexedCloudGroupRow } from './cloudMessageIndex';
import { loadSession } from './session';
import {
  handleCloudGroupAgentFailure,
  type HandleCloudGroupAgentFailureInput,
} from './cloudGroupAgentFailure';
import type {
  CanonicalSessionStateSetter,
  CloudGroupAgentRuntime,
  CloudGroupMessageControlContext,
} from './cloudGroupControlContext';

type CloudGroupAgentStateOps = HandleCloudGroupAgentFailureInput['stateOps'] & {
  upsertIdentity(
    current: CanonicalSessionState | null,
    identity: CanonicalIdentity,
  ): CanonicalSessionState | null;
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

type CloudGroupAgentPolicy = {
  isRecentMention(createdAt: string): boolean;
  messageTargetsLocalAgent(
    message: NonNullable<CloudGroupMessageControlContext['envelope']['message']>,
    account: CloudGroupMessageControlContext['account'],
  ): boolean;
  responseExists(input: {
    localAccountId: string;
    requestMessageId: string;
    messages?: readonly CloudMessage[];
    groupRows?: readonly IndexedCloudGroupRow[];
  }): boolean;
  fallbackRunOwnsRequest(input: {
    client: CloudGroupAgentRuntime['client'];
    token: string;
    requestMessageId: string;
  }): Promise<boolean>;
  nativeContext(input: {
    groupRows: readonly IndexedCloudGroupRow[];
    groupId: string;
    requestMessageId: string;
    requestCreatedAtMs: number;
  }): DesktopChatContextMessage[];
  waitForTurn(
    turnId: string,
    onSnapshot?: (snapshot: DesktopChatTurnSnapshot) => void,
  ): Promise<DesktopChatTurnSnapshot>;
  publishActivity(input: {
    client: CloudGroupAgentRuntime['client'];
    token: string;
    accountId: string;
    sessionId: string;
    participantAccountIds: string[];
    participantProfiles?: CloudActivityParticipantProfile[];
    turn: DesktopChatTurnSnapshot;
    mergeActivity(snapshot: CloudSessionActivityStore): void;
  }): Promise<void>;
};

export type ApplyCloudGroupAgentControlInput = {
  context: CloudGroupMessageControlContext;
  setCanonicalState: CanonicalSessionStateSetter;
  runtime: CloudGroupAgentRuntime;
  stateOps: CloudGroupAgentStateOps;
  policy: CloudGroupAgentPolicy;
};

export function applyCloudGroupAgentControl(input: ApplyCloudGroupAgentControlInput): void {
  const {
    context,
    setCanonicalState,
    runtime,
    stateOps,
    policy,
  } = input;
  const {
    account,
    cloudMessage,
    envelope,
    senderIsAgent,
  } = context;
  const message = envelope.message;
  if (
    !message
    || senderIsAgent
    || !policy.messageTargetsLocalAgent(message, account)
    || !policy.isRecentMention(cloudMessage.createdAt)
    || runtime.processedMentionIds.has(message.id)
  ) return;

  const currentCloudMessageIndex = runtime.messageIndex();
  if (
    cloudGroupLocalAgentRequestAlreadyHandled({
      localAccountId: account.accountId,
      requestMessageId: message.id,
      groupRows: currentCloudMessageIndex.groupRows,
    })
    || policy.responseExists({
      localAccountId: account.accountId,
      requestMessageId: message.id,
      groupRows: currentCloudMessageIndex.groupRows,
    })
  ) {
    runtime.processedMentionIds.add(message.id);
    return;
  }
  runtime.processedMentionIds.add(message.id);
  void respondToCloudGroupAgentMention(input, currentCloudMessageIndex.groupRows)
    .catch((error) => handleCloudGroupAgentFailure(error, {
      context,
      setCanonicalState,
      runtime,
      stateOps,
    }));
}

async function respondToCloudGroupAgentMention(
  {
    context,
    setCanonicalState,
    runtime,
    stateOps,
    policy,
  }: ApplyCloudGroupAgentControlInput,
  groupRows: readonly IndexedCloudGroupRow[],
): Promise<void> {
  const {
    account,
    cloudMessage,
    envelope,
    groupSpaceId,
    localHumanIdentityId,
    mappedAttachments,
    participantByAccount,
  } = context;
  const message = envelope.message!;
  const session = await loadSession();
  if (!session?.token) throw new Error('Not signed in.');
  const targetAccountIds = cloudGroupAgentResponseTargetAccountIds({
    localAccountId: account.accountId,
    envelope,
    requestCloudMessage: cloudMessage,
  });
  const latestTargetMessages = (await Promise.all(
    targetAccountIds.map((targetAccountId) => runtime.client
      .listMessages(session.token, targetAccountId, 100)
      .catch(() => [])),
  )).flat();
  if (
    await policy.fallbackRunOwnsRequest({
      client: runtime.client,
      token: session.token,
      requestMessageId: message.id,
    })
    || policy.responseExists({
      localAccountId: account.accountId,
      requestMessageId: message.id,
      messages: latestTargetMessages,
      groupRows,
    })
  ) {
    void runtime.syncDiff();
    return;
  }

  const hostedAgentName = stateOps.cleanText(message.targetCloudAgentName);
  const hostedAgentOwnerName = stateOps.cleanText(message.targetCloudAgentOwnerName)
    || stateOps.cleanText(account.displayName)
    || stateOps.cleanText(account.primaryEmail)
    || 'Cloud user';
  const agentIdentityId = `agent:cloud:${account.accountId}`;
  const agentDisplayName = hostedAgentName || `${hostedAgentOwnerName}'s Kordi`;
  const agentIdentity = await upsertCanonicalIdentityFast({
    id: agentIdentityId,
    kind: 'agent',
    displayName: agentDisplayName,
    ownerIdentityId: localHumanIdentityId,
    source: 'local',
    sourceHostId: 'cloud',
    sourceIdentityId: `cloud-agent:${account.accountId}`,
    humanId: account.accountId,
    agentId: `cloud-agent:${account.accountId}`,
    avatarKey: `cloud-agent:${account.accountId}`,
    profileImageUrl: null,
    metadata: { accountId: account.accountId, cloudGroupAgent: true },
  });
  setCanonicalState((current) => stateOps.upsertIdentity(current, agentIdentity));

  const processingMessageId = `msg:cloud-agent-processing:${message.id}:${account.accountId}`;
  const processingCreatedAtMs = Date.now();
  const processingRequest = {
    id: processingMessageId,
    sessionId: envelope.groupId,
    senderIdentityId: agentIdentityId,
    senderRole: 'owned-agent',
    messageKind: 'agent-turn',
    contentText: 'processing...',
    content: {
      sender: agentDisplayName,
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
  await upsertCanonicalMessageFast(processingRequest);
  setCanonicalState((current) => stateOps.upsertRequest(current, processingRequest));
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
        senderDisplayName: agentDisplayName,
        deliveryState: 'processing',
        replyToMessageId: message.id,
        requestId: message.id,
      },
    }),
    sessionId: envelope.groupId,
    createdAtMs: processingCreatedAtMs,
  });

  const contextMessages = [
    ...cloudAgentContextMessagesFromDefinition(
      runtime.agentDefinitionsById[message.targetCloudAgentId ?? ''] ?? null,
    ),
    ...policy.nativeContext({
      groupRows,
      groupId: envelope.groupId,
      requestMessageId: message.id,
      requestCreatedAtMs: message.createdAtMs,
    }),
  ];
  const rememberLocalTurn = (turn: DesktopChatTurnSnapshot) => {
    runtime.setLocalTurns((current) => ({ ...current, [message.id]: turn }));
  };
  const runtimeSessionId = `${CLOUD_AGENT_RUNTIME_SESSION_PREFIX}${account.accountId}:${envelope.groupId}`;
  const startedTurn = await startDesktopChatMessage(
    runtimeSessionId,
    promptTextForCloudAgentMention(message.text),
    mappedAttachments.map((attachment) => attachment.localPath?.trim() || '').filter(Boolean),
    cloudAgentRuntimeRouteForTargetCloudAgent({
      targetCloudAgentId: message.targetCloudAgentId,
      cloudAgentDefinitionsById: runtime.agentDefinitionsById,
      routesByRuntimeSessionId: runtime.routesBySessionId,
      runtimeSessionId,
      fallbackRoute: runtime.defaultRoute,
    }),
    contextMessages,
    cloudVisibleTaskRecordsForSession(runtime.sessionActivity(), envelope.groupId),
    envelope.groupId,
  );
  rememberLocalTurn(startedTurn);
  runtime.turnIdsByRequestId.set(message.id, startedTurn.id);
  const finalTurn = startedTurn.completed
    ? startedTurn
    : await policy.waitForTurn(startedTurn.id, rememberLocalTurn);
  rememberLocalTurn(finalTurn);
  runtime.turnIdsByRequestId.delete(message.id);
  if (finalTurn.status === 'cancelled') return;
  await policy.publishActivity({
    client: runtime.client,
    token: session.token,
    accountId: account.accountId,
    sessionId: envelope.groupId,
    participantAccountIds: [...participantByAccount.keys()],
    participantProfiles: [...participantByAccount.values()].map((participant) => ({
      accountId: participant.accountId,
      displayName: participant.displayName,
      avatarUrl: participant.avatarUrl,
      role: participant.role,
    })),
    turn: finalTurn,
    mergeActivity: (snapshot) => runtime.setSessionActivity(
      (current) => mergeCloudSessionActivity(current, snapshot),
    ),
  });

  const succeeded = finalTurn.succeeded && finalTurn.assistantText.trim().length > 0;
  const failureMessage = succeeded
    ? null
    : isCloudAgentNoProviderConfiguredError(finalTurn.error || finalTurn.message)
      ? cloudAgentNoProviderNoticeText()
      : finalTurn.error?.trim()
        || finalTurn.message?.trim()
        || 'Cloud agent returned no text response';
  const finalLatestTargetMessages = (await Promise.all(
    targetAccountIds.map((targetAccountId) => runtime.client
      .listMessages(session.token, targetAccountId, 100)
      .catch(() => [])),
  )).flat();
  if (
    await policy.fallbackRunOwnsRequest({
      client: runtime.client,
      token: session.token,
      requestMessageId: message.id,
    })
    || policy.responseExists({
      localAccountId: account.accountId,
      requestMessageId: message.id,
      messages: finalLatestTargetMessages,
      groupRows,
    })
  ) {
    void runtime.syncDiff();
    return;
  }

  const responseDeliveryState: 'complete' | 'failed' = succeeded ? 'complete' : 'failed';
  const responseMessageId = `msg:cloud-agent:${finalTurn.id}`;
  const responseCreatedAtMs = Date.now();
  const responseRequest = {
    ...processingRequest,
    contentText: succeeded ? finalTurn.assistantText.trim() : '',
    content: {
      sender: agentDisplayName,
      timestampMs: responseCreatedAtMs,
      deliveryState: responseDeliveryState,
      sourceConversationId: cloudGroupAgentConversationId(envelope.groupId),
      requestId: message.id,
      replyToMessageId: message.id,
      ...(failureMessage ? { error: failureMessage } : {}),
    },
    createdAtMs: responseCreatedAtMs,
    status: responseDeliveryState,
    sourceEventId: `cloud-group-agent:${responseMessageId}`,
  } satisfies AppendCanonicalMessageRequest;
  await upsertCanonicalMessageFast(responseRequest);
  const offlinePlaceholderId = `msg:cloud-agent-offline:${message.id}:${account.accountId}`;
  setCanonicalState((current) => {
    const withResponse = stateOps.upsertRequest(current, responseRequest);
    if (!withResponse) return withResponse;
    return stateOps.removePendingRows(withResponse, message.id, account.accountId)
      ?? stateOps.removeTimeoutPlaceholder(withResponse, offlinePlaceholderId)
      ?? withResponse;
  });
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
        id: responseMessageId,
        senderAccountId: account.accountId,
        text: succeeded ? finalTurn.assistantText.trim() : (failureMessage ?? ''),
        createdAtMs: responseCreatedAtMs,
        senderKind: 'agent',
        senderDisplayName: agentDisplayName,
        deliveryState: responseDeliveryState,
        replyToMessageId: message.id,
        requestId: message.id,
      },
    }),
    sessionId: envelope.groupId,
    createdAtMs: responseCreatedAtMs,
  });
  void runtime.syncDiff();
}

async function publishCloudGroupAgentEnvelope({
  runtime,
  token,
  targetAccountIds,
  body,
  sessionId,
  createdAtMs,
}: {
  runtime: CloudGroupAgentRuntime;
  token: string;
  targetAccountIds: string[];
  body: string;
  sessionId: string;
  createdAtMs: number;
}): Promise<void> {
  const sent = await Promise.allSettled(targetAccountIds.map((targetAccountId) => (
    runtime.client.sendMessage(token, targetAccountId, body, {
      sessionId,
      clientCreatedAt: new Date(createdAtMs).toISOString(),
    })
  )));
  sent.forEach((result) => {
    if (result.status === 'fulfilled') runtime.mergeMessage(result.value);
  });
}
