import { mergeCanonicalMessageRow } from '@/features/canonical/canonicalStateReducers';
import {
  beginChatPerformanceSpan,
  finishChatPerformanceSpan,
} from '@/features/performance/chatPerformance';
import type {
  DesktopChatTurnSnapshot
} from '@/kordi-app/types';
import {
  upsertCanonicalMessageFast
} from '@/lib/desktop';
import { cloudGroupAgentCancelledNoticeRequest } from "./cloudAgentCancellation";
import type { ApplyCloudGroupAgentControlInput } from "./cloudGroupAgentControl.types";
import {
  cloudGroupAgentConversationId
} from "./cloudGroupMessages";

export function throwIfCloudAgentTurnAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error('Cloud agent turn context changed.');
  }
}

export async function waitForCloudGroupAgentTurn(
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

export async function persistCloudGroupAgentCancellation(
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

export function clearCloudGroupAgentPendingState(
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
