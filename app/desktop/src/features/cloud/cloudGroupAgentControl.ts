import {
  beginChatPerformanceSpan,
  finishChatPerformanceSpan,
} from '@/features/performance/chatPerformance';
import { cloudGroupAgentRequestRuntimeSessionId, cloudGroupAgentRuntimeSessionId } from './cloudAgentRuntime';
import type { ApplyCloudGroupAgentControlInput } from './cloudGroupAgentControl.types';
import { respondToCloudGroupAgentMention } from './cloudGroupAgentExecution';
import { handleCloudGroupAgentFailure } from './cloudGroupAgentFailure';
import { persistPendingCloudGroupAgentTurn } from './cloudGroupAgentPersistence';
import { cloudGroupLocalAgentRequestAlreadyHandled } from './cloudGroupLocalAgentRequestState';

export type { ApplyCloudGroupAgentControlInput } from './cloudGroupAgentControl.types';

export async function applyCloudGroupAgentControl(
  input: ApplyCloudGroupAgentControlInput,
): Promise<void> {
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
  } = context;
  const message = envelope.message;
  if (
    !message
    || !policy.messageTargetsLocalAgent(
      message,
      account,
      envelope.participants,
    )
    || !policy.isRecentMention(cloudMessage.createdAt)
    || runtime.processedMentionIds.has(message.id)
  ) return;

  const replaySpan = beginChatPerformanceSpan('cloud-group-replay');
  const currentRows = runtime.messageIndex().groupRows;
  if (
    cloudGroupLocalAgentRequestAlreadyHandled({
      localAccountId: account.accountId,
      requestMessageId: message.id,
      groupRows: currentRows,
      ignoreFailedCloudFallback: true,
    })
    || policy.responseExists({
      localAccountId: account.accountId,
      requestMessageId: message.id,
      groupRows: currentRows,
      ignoreFailedCloudFallback: true,
    })
  ) {
    runtime.processedMentionIds.add(message.id);
    finishChatPerformanceSpan(replaySpan, { resultClass: 'duplicate' });
    return;
  }

  const runtimeSessionId = cloudGroupAgentRuntimeSessionId(
    account.accountId,
    envelope.groupId,
    message.targetCloudAgentId,
  );
  if (!runtimeSessionId) {
    finishChatPerformanceSpan(replaySpan, { resultClass: 'failed' });
    return;
  }

  const contextSignal = runtime.turnCoordinator.activeContextSignal();
  const admission = runtime.turnCoordinator.enqueue({
    runtimeSessionId: cloudGroupAgentRequestRuntimeSessionId(runtimeSessionId, message.id),
    requestId: message.id,
    run: (signal) => respondToCloudGroupAgentMention(
      input,
      runtime.messageIndex().groupRows,
      runtimeSessionId,
      signal,
    ),
    onError: (error, signal) => handleCloudGroupAgentFailure(error, {
      context,
      setCanonicalState,
      runtime,
      stateOps,
      signal,
    }),
  });
  runtime.processedMentionIds.add(message.id);
  if (!admission.accepted) {
    finishChatPerformanceSpan(replaySpan, { resultClass: 'duplicate' });
    return;
  }

  try {
    await persistPendingCloudGroupAgentTurn(input, contextSignal);
    finishChatPerformanceSpan(replaySpan, {
      resultClass: admission.queued ? 'queued' : 'success',
    });
  } catch (error) {
    finishChatPerformanceSpan(replaySpan, { resultClass: 'failed' });
    throw error;
  }
}
