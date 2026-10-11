import { isCancellationNotice } from '@/features/chat/cancellation';
import { isProcessingPlaceholderText } from '@/features/collaboration/agentPlaceholderText';
import type { DesktopChatTurnSnapshot } from '@/kordi-app/types';
import type { CloudAuthClient, CloudMessage, SendCloudMessageOptions } from './authClient';
import {
  encodeCloudAgentResponse,
  type CloudAgentBackgroundSession,
  type CloudAgentExecutionSnapshot,
  type CloudAgentReplyEnding,
} from './cloudAgentMessages';
import { cloudAgentLocalFailureMessage } from './cloudAgentLocalExecution';
import { closeCloudAgentRunFromDesktop } from './cloudInterruptedTurnRelease';

/** The reply of a request stopped before the agent produced any text. */
export const CLOUD_AGENT_STOPPED_TEXT = 'Request stopped.';

export type CloudSelfAgentTerminalReply = {
  deliveryState: 'complete' | 'failed' | 'cancelled';
  text: string;
  ending?: CloudAgentReplyEnding;
};

function partialReplyText(...candidates: (string | null | undefined)[]) {
  for (const candidate of candidates) {
    const text = candidate?.trim() ?? '';
    if (text && !isCancellationNotice(text) && !isProcessingPlaceholderText(text)) return text;
  }
  return '';
}

/** A stopped reply keeps the text streamed so far; without text it is the short notice. */
export function cloudSelfAgentStoppedReply(streamedText?: string | null): CloudSelfAgentTerminalReply {
  const text = partialReplyText(streamedText);
  return text
    ? { deliveryState: 'cancelled', text, ending: 'stopped' }
    : { deliveryState: 'cancelled', text: CLOUD_AGENT_STOPPED_TEXT };
}

/** An interrupted reply keeps the text streamed so far; without text it explains the failure. */
export function cloudSelfAgentInterruptedReply(
  streamedText: string | null | undefined,
  failure: unknown,
): CloudSelfAgentTerminalReply {
  const text = partialReplyText(streamedText);
  return text
    ? { deliveryState: 'failed', text, ending: 'interrupted' }
    : { deliveryState: 'failed', text: cloudAgentLocalFailureMessage(failure) };
}

/**
 * The terminal reply of a hosted turn. A user stop ends it as cancelled; a
 * lost lease or runtime error ends it as failed. Either keeps the streamed
 * text with a marker of how it ended.
 */
export function cloudSelfAgentTerminalReply({
  turn,
  streamedText,
  stopRequested,
  leaseLost,
}: {
  turn: Pick<DesktopChatTurnSnapshot, 'status' | 'succeeded' | 'assistantText' | 'error' | 'message'>;
  streamedText?: string | null;
  stopRequested: boolean;
  leaseLost: boolean;
}): CloudSelfAgentTerminalReply {
  const answer = turn.assistantText.trim();
  if (turn.succeeded && answer) return { deliveryState: 'complete', text: answer };
  const partial = partialReplyText(answer, streamedText);
  // A lost lease cancels the native turn too; only a stop ends it as stopped.
  if (stopRequested || (turn.status === 'cancelled' && !leaseLost)) {
    return cloudSelfAgentStoppedReply(partial);
  }
  return cloudSelfAgentInterruptedReply(
    partial,
    leaseLost && !turn.error ? 'Execution lease lost.' : turn.error || turn.message,
  );
}

/** The local turn that shows a settled reply until the published one syncs. */
export function settledCloudSelfAgentTurn(
  turn: DesktopChatTurnSnapshot,
  reply: CloudSelfAgentTerminalReply,
  completedAtMs = Date.now(),
): DesktopChatTurnSnapshot {
  const complete = reply.deliveryState === 'complete';
  return {
    ...turn,
    status: complete ? 'complete' : reply.deliveryState,
    message: complete ? 'Complete' : reply.deliveryState === 'cancelled' ? 'Stopped' : 'Failed',
    assistantText: complete || reply.ending ? reply.text : reply.deliveryState === 'cancelled' ? '' : turn.assistantText,
    completed: true,
    succeeded: complete,
    completedAtMs: turn.completedAtMs ?? completedAtMs,
    error: reply.deliveryState === 'failed' && !reply.ending ? reply.text : null,
    ending: reply.ending,
    hostedRunStatus: undefined,
  };
}

const RUN_STATE = { complete: 'completed', failed: 'failed', cancelled: 'cancelled' } as const;

/**
 * Publishes the terminal reply and ends the run in the same step. When the
 * lease is gone the publication fails; the closing route then ends the run
 * and the server publishes the same reply, so no device keeps showing the
 * request as running.
 */
export async function settleCloudSelfAgentTerminalReply({
  client,
  publisher,
  token,
  accountId,
  sessionId,
  requestId,
  reply,
  execution,
  backgroundSessions,
  clientMessageId,
  publish = true,
  reportWarning,
}: {
  client: Pick<CloudAuthClient, 'desktopAgentExecution'>;
  publisher: {
    sendMessage: (token: string, peer: string, body: string, options?: SendCloudMessageOptions) => Promise<CloudMessage>;
  };
  token: string;
  accountId: string;
  sessionId: string;
  requestId: string;
  reply: CloudSelfAgentTerminalReply;
  execution?: CloudAgentExecutionSnapshot;
  backgroundSessions?: CloudAgentBackgroundSession[];
  clientMessageId: string;
  /** False when another device already published the terminal reply. */
  publish?: boolean;
  reportWarning?: (message: string, error: unknown) => void;
}): Promise<CloudMessage | null> {
  let response: CloudMessage | null = null;
  if (publish) {
    try {
      response = await publisher.sendMessage(
        token,
        accountId,
        encodeCloudAgentResponse({
          requestId,
          text: reply.text,
          deliveryState: reply.deliveryState,
          ending: reply.ending,
          execution,
          backgroundSessions,
        }),
        { sessionId, clientMessageId },
      );
    } catch (error) {
      reportWarning?.('[cloud-self-agent-execution] terminal reply publish failed', error);
    }
  }
  if (response === null || reply.deliveryState !== 'complete') {
    try {
      await closeCloudAgentRunFromDesktop(client, token, {
        sessionId,
        requestId,
        state: RUN_STATE[reply.deliveryState],
        text: reply.text,
        ending: reply.ending,
      });
    } catch (error) {
      reportWarning?.('[cloud-self-agent-execution] run close failed', error);
    }
  }
  return response;
}
