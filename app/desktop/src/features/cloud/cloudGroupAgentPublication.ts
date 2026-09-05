import {
  beginChatPerformanceSpan,
  finishChatPerformanceSpan,
} from '@/features/performance/chatPerformance';
import {
  cloudGroupAgentGuardDecision,
  loadCloudGroupAgentTargetMessages,
} from './cloudGroupAgentGuard';
import {
  cloudGroupSelfParticipant,
  encodeCloudGroupControl,
} from './cloudGroupMessages';
import type {
  CloudGroupAgentRuntime,
  CloudGroupMessageControlContext,
} from './cloudGroupControlContext';
import type { CloudGroupAgentHandoff } from './cloudGroupMentions';
import type { CloudGroupAgentPolicy } from './cloudGroupAgentControl.types';
import type { CloudAgentExecutionTool } from './cloudAgentMessages';
import type { CloudAuthClient } from './authClient';
import { cloudOperationUuid } from './chatSyncMapping';
import { parseCloudGroupControl } from './cloudGroupMessages';

export async function publishCloudGroupAgentTerminalAfterGuards({
  context,
  runtime,
  policy,
  token,
  targetAccountIds,
  responseMessageId,
  responseCreatedAtMs,
  responseText,
  responseDeliveryState,
  responseTools,
  agentId,
  agentDisplayName,
  agentHandoff,
  signal,
  publisher,
}: {
  context: CloudGroupMessageControlContext;
  runtime: CloudGroupAgentRuntime;
  policy: CloudGroupAgentPolicy;
  token: string;
  targetAccountIds: string[];
  responseMessageId: string;
  responseCreatedAtMs: number;
  responseText: string;
  responseDeliveryState: 'complete' | 'failed';
  responseTools: CloudAgentExecutionTool[];
  agentId: string;
  agentDisplayName: string;
  agentHandoff: CloudGroupAgentHandoff | null;
  signal: AbortSignal;
  publisher?: Pick<CloudAuthClient, 'sendMessage'>;
}): Promise<void> {
  if (signal.aborted) return;
  const {
    account,
    envelope,
    groupSpaceId,
    participantByAccount,
  } = context;
  const message = envelope.message!;
  const guardSpan = beginChatPerformanceSpan(
    'cloud-agent-ownership-guard',
  );
  const guardDecision = publisher ? { requestAlreadyOwned: false, resultClass: 'success' as const } : await cloudGroupAgentGuardDecision({
    loadMessages: () => loadCloudGroupAgentTargetMessages(
      runtime,
      token,
      targetAccountIds,
    ),
    fallbackOwnsRequest: () => policy.fallbackRunOwnsRequest({
      client: runtime.client,
      token,
      requestMessageId: message.id,
    }),
    responseExists: (messages) => policy.responseExists({
      localAccountId: account.accountId,
      requestMessageId: message.id,
      messages,
      groupRows: runtime.messageIndex().groupRows,
      ignoreFailedCloudFallback: responseDeliveryState === 'complete',
    }),
  });
  finishChatPerformanceSpan(guardSpan, {
    resultClass: guardDecision.resultClass,
  });
  if (signal.aborted) return;
  const fanoutSpan = beginChatPerformanceSpan(
    'cloud-agent-terminal-fanout',
  );
  if (!guardDecision.requestAlreadyOwned) {
    const fanout = await publishCloudGroupAgentEnvelope({
      publisher,
      runtime,
      token,
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
          senderAgentId: agentId,
          text: responseText,
          createdAtMs: responseCreatedAtMs,
          senderKind: 'agent',
          senderDisplayName: agentDisplayName,
          deliveryState: responseDeliveryState,
          replyToMessageId: message.id,
          requestId: message.id,
          ...(message.messageAction?.kind === 'thread' ? { messageAction: message.messageAction } : {}),
          structuredContent: responseTools.length > 0
            ? { tools: responseTools }
            : null,
          ...(agentHandoff ?? {}),
        },
      }),
      sessionId: envelope.groupId,
      createdAtMs: responseCreatedAtMs,
      signal,
    });
    finishChatPerformanceSpan(fanoutSpan, {
      resultClass: fanout.failedCount === 0
        ? 'success'
        : fanout.sentCount > 0
          ? 'partial'
          : 'failed',
      recipientCount: targetAccountIds.length,
      errorCount: fanout.failedCount,
    });
  } else {
    finishChatPerformanceSpan(fanoutSpan, {
      resultClass: 'owned-elsewhere',
      recipientCount: targetAccountIds.length,
    });
  }
  if (!signal.aborted) void runtime.syncDiff();
}

export async function publishCloudGroupAgentEnvelope({
  runtime,
  token,
  targetAccountIds,
  body,
  sessionId,
  createdAtMs,
  signal,
  publisher,
}: {
  runtime: CloudGroupAgentRuntime;
  token: string;
  targetAccountIds: string[];
  body: string;
  sessionId: string;
  createdAtMs: number;
  signal?: AbortSignal;
  publisher?: Pick<CloudAuthClient, 'sendMessage'>;
}): Promise<{ sentCount: number; failedCount: number }> {
  const sent = await Promise.allSettled(targetAccountIds.map((targetAccountId) => (
    (publisher ?? runtime.client).sendMessage(token, targetAccountId, body, {
      ...(publisher ? { clientMessageId: cloudOperationUuid(`group-agent:${sessionId}:${parseCloudGroupControl(body)?.message?.id ?? createdAtMs}`) } : {}),
      sessionId,
      clientCreatedAt: new Date(createdAtMs).toISOString(),
      conversationKind: 'group',
      memberAccountIds: targetAccountIds,
    })
  )));
  sent.forEach((result) => {
    if (result.status === 'fulfilled' && !signal?.aborted) {
      runtime.mergeMessage(result.value);
    }
  });
  return {
    sentCount: sent.filter((result) => result.status === 'fulfilled').length,
    failedCount: sent.filter((result) => result.status === 'rejected').length,
  };
}
