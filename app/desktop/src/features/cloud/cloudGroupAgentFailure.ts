import { upsertCanonicalMessageFast } from '@/lib/desktop';
import type {
  AppendCanonicalMessageRequest,
  CanonicalSessionState,
} from '@/kordi-app/types';
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
import type {
  CanonicalSessionStateSetter,
  CloudGroupAgentRuntime,
  CloudGroupMessageControlContext,
} from './cloudGroupControlContext';

type CloudGroupAgentFailureStateOps = {
  cleanText(value?: string | null): string;
  upsertRequest(
    current: CanonicalSessionState | null,
    request: AppendCanonicalMessageRequest,
  ): CanonicalSessionState | null;
};

export type HandleCloudGroupAgentFailureInput = {
  context: CloudGroupMessageControlContext;
  setCanonicalState: CanonicalSessionStateSetter;
  runtime: CloudGroupAgentRuntime;
  stateOps: CloudGroupAgentFailureStateOps;
};

export function handleCloudGroupAgentFailure(
  error: unknown,
  {
    context,
    setCanonicalState,
    runtime,
    stateOps,
  }: HandleCloudGroupAgentFailureInput,
): void {
  const { account, cloudMessage, envelope, groupSpaceId, participantByAccount } = context;
  const message = envelope.message;
  if (!message) return;
  runtime.turnIdsByRequestId.delete(message.id);
  if (!isCloudAgentNoProviderConfiguredError(error)) {
    runtime.processedMentionIds.delete(message.id);
    runtime.reportFailure('local-response', error);
    return;
  }

  const responseCreatedAtMs = Date.now();
  const processingMessageId = `msg:cloud-agent-processing:${message.id}:${account.accountId}`;
  const responseMessageId = `msg:cloud-agent-no-provider:${message.id}:${account.accountId}`;
  const hostedAgentName = stateOps.cleanText(message.targetCloudAgentName);
  const hostedAgentOwnerName = stateOps.cleanText(message.targetCloudAgentOwnerName)
    || stateOps.cleanText(account.displayName)
    || stateOps.cleanText(account.primaryEmail)
    || 'Cloud user';
  const agentDisplayName = hostedAgentName || `${hostedAgentOwnerName}'s Kordi`;
  void (async () => {
    const failedResponseRequest = {
      id: processingMessageId,
      sessionId: envelope.groupId,
      senderIdentityId: `agent:cloud:${account.accountId}`,
      senderRole: 'owned-agent',
      messageKind: 'agent-turn',
      contentText: '',
      content: {
        sender: agentDisplayName,
        timestampMs: responseCreatedAtMs,
        deliveryState: 'failed',
        sourceConversationId: cloudGroupAgentConversationId(envelope.groupId),
        requestId: message.id,
        replyToMessageId: message.id,
        error: cloudAgentNoProviderNoticeText(),
      },
      createdAtMs: responseCreatedAtMs,
      parentMessageId: message.id,
      status: 'failed',
      sourceTransport: 'cloud-group-agent',
      sourceEventId: `cloud-group-agent-no-provider:${message.id}:${account.accountId}`,
    } satisfies AppendCanonicalMessageRequest;
    await upsertCanonicalMessageFast(failedResponseRequest);
    setCanonicalState((current) => stateOps.upsertRequest(current, failedResponseRequest));
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
        text: cloudAgentNoProviderNoticeText(),
        createdAtMs: responseCreatedAtMs,
        senderKind: 'agent',
        senderDisplayName: agentDisplayName,
        deliveryState: 'failed',
        replyToMessageId: message.id,
        requestId: message.id,
      },
    });
    const sent = await Promise.allSettled(
      targetAccountIds.map((targetAccountId) => runtime.client.sendMessage(
        session.token,
        targetAccountId,
        responseBody,
        {
          sessionId: envelope.groupId,
          clientCreatedAt: new Date(responseCreatedAtMs).toISOString(),
        },
      )),
    );
    sent.forEach((result) => {
      if (result.status === 'fulfilled') runtime.mergeMessage(result.value);
    });
    void runtime.syncDiff();
  })().catch((saveError) => {
    runtime.processedMentionIds.delete(message.id);
    runtime.reportFailure('no-provider-notice', saveError);
  });
}
