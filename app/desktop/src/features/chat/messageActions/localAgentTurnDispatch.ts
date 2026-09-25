import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import { cloudAgentNoProviderNoticeText, isCloudAgentNoProviderConfiguredError } from '@/features/cloud/cloudAgentMessages';
import { routeRunsOnKordiCloud } from '@/features/cloud/cloudAgentRuntimeRoute';
import type { CanonicalSessionState, DesktopChatTurnSnapshot } from '@/kordi-app/types';
import {
  appendCanonicalMessage,
  startDesktopChatMessage,
  upsertCanonicalMessage,
  upsertCanonicalMessageFast,
  type DesktopChatContextMessage,
  type DesktopChatMessageRoute,
} from '@/lib/desktop';

import type { AttachmentItem } from '../composerController.types';
import type { VoiceTranscriptionOutcome } from '../voiceTranscription';
import { canonicalNoProviderFailedAgentMessageRequest } from './agentMessageLifecycle';
import { markOptimisticCanonicalMessageSent, sentPreparedCanonicalUserMessage } from './canonicalDelivery';
import { appendCanonicalRequestToLocalState } from './canonicalSendState';
import { markOptimisticCanonicalMessageFailed, type PreparedCanonicalUserMessage } from './optimistic';
import { voiceMessageAgentText } from './optimisticAttachments';
import { transcribeAgentVoiceAttachments } from './voiceAgentTranscription';
import { preparedCanonicalUserMessageWithAttachments, replaceOptimisticCanonicalMessageContent } from './voiceCanonicalContent';

/** Everything needed to start and follow one local agent turn for a user message that is already stored. */
export type LocalAgentTurnContext = {
  targetConversationId: string;
  canonicalSessionId: string;
  canonicalSessionState: CanonicalSessionState | null;
  text: string;
  attachmentPaths: string[];
  route: DesktopChatMessageRoute | null;
  contextMessages: DesktopChatContextMessage[];
  setCanonicalSessionState: Dispatch<SetStateAction<CanonicalSessionState | null>>;
  setDesktopChatError: (error: string | null) => void;
  watchTurn: (
    turn: DesktopChatTurnSnapshot,
    onComplete?: (finalTurn: DesktopChatTurnSnapshot) => Promise<void> | void,
  ) => void;
};

export { routeRunsOnKordiCloud };

/** Frees the session for the next send; a Kordi Cloud turn has no local turn to wait for. */
export function releaseLocalChatSend(inFlightRef: MutableRefObject<{ sessionId: string | null } | null>, sessionId: string) {
  if (inFlightRef.current?.sessionId === sessionId) inFlightRef.current = null;
}

/**
 * Starts the agent turn for a stored user message. A route on a hosted-only
 * account runs on Kordi Cloud instead: the message is delivered with its route,
 * the cloud request carries it to the runner, and nothing runs on this Mac,
 * so the result is null.
 */
export async function startLocalAgentTurn(
  context: LocalAgentTurnContext,
  prepared: PreparedCanonicalUserMessage | null,
  attachments: readonly AttachmentItem[],
): Promise<DesktopChatTurnSnapshot | null> {
  if (routeRunsOnKordiCloud(context.route)) {
    await markLocalAgentMessageDelivered(context, prepared);
    return null;
  }
  const turn = await startDesktopChatMessage(
    context.targetConversationId,
    voiceMessageAgentText(context.text, attachments),
    context.attachmentPaths,
    context.route,
    context.contextMessages,
    [],
    null,
    prepared?.messageId ?? null,
  );
  return prepared
    ? { ...turn, replyToMessageId: prepared.messageId }
    : turn;
}

/** The delivered message; a Kordi Cloud turn keeps its route so the cloud request can carry it. */
function deliveredCanonicalMessage(context: LocalAgentTurnContext, prepared: PreparedCanonicalUserMessage | null) {
  const sent = sentPreparedCanonicalUserMessage(prepared);
  if (!sent || !context.route || !routeRunsOnKordiCloud(context.route)) return sent;
  const content = sent.request.content && typeof sent.request.content === 'object' ? sent.request.content : {};
  return { ...sent, request: { ...sent.request, content: { ...content, agentRuntimeRoute: context.route } } };
}

export function markLocalAgentMessageDelivered(
  context: LocalAgentTurnContext,
  prepared: PreparedCanonicalUserMessage | null,
): Promise<void> {
  const sentCanonicalMessage = deliveredCanonicalMessage(context, prepared);
  if (!sentCanonicalMessage) return Promise.resolve();
  context.setCanonicalSessionState((current) => markOptimisticCanonicalMessageSent(
    current,
    context.canonicalSessionId,
    sentCanonicalMessage.messageId,
  ));
  return upsertCanonicalMessageFast(sentCanonicalMessage.request).then(() => undefined, (error: unknown) => {
    context.setDesktopChatError(error instanceof Error ? error.message : 'Unable to update message delivery status');
  });
}

/** When the finished turn reports a missing provider, store the delivered request and a failed reply notice. */
export function localAgentNoProviderCompletion(
  context: LocalAgentTurnContext,
  prepared: PreparedCanonicalUserMessage | null,
) {
  return async (finalTurn: DesktopChatTurnSnapshot) => {
    const noProviderFailure = isCloudAgentNoProviderConfiguredError(finalTurn.error || finalTurn.message || finalTurn.assistantText);
    if (!noProviderFailure || !prepared) return;
    const sentUserRequest = {
      ...prepared.request,
      status: 'sent',
      content: {
        ...(prepared.request.content && typeof prepared.request.content === 'object' ? prepared.request.content : {}),
        deliveryState: 'sent',
      },
    };
    try {
      const stateAfterUser = await upsertCanonicalMessage(sentUserRequest);
      const failedReplyRequest = canonicalNoProviderFailedAgentMessageRequest({
        state: stateAfterUser ?? context.canonicalSessionState,
        sessionId: context.canonicalSessionId,
        requestMessageId: prepared.messageId,
      });
      const nextState = failedReplyRequest ? await appendCanonicalMessage(failedReplyRequest) : stateAfterUser;
      if (nextState) context.setCanonicalSessionState(nextState);
    } catch (error) {
      context.setCanonicalSessionState((current) => markOptimisticCanonicalMessageFailed(
        current,
        context.canonicalSessionId,
        prepared.messageId,
        cloudAgentNoProviderNoticeText(),
      ));
      context.setDesktopChatError(error instanceof Error ? error.message : 'Unable to save provider notice');
    }
  };
}

/**
 * A voice message is delivered to its local agent session as soon as it is stored. Only the agent turn
 * waits for the words, in the background, so the bubble never returns to "sending".
 */
export function dispatchLocalAgentVoiceTurn(
  context: LocalAgentTurnContext,
  prepared: PreparedCanonicalUserMessage | null,
  attachments: readonly AttachmentItem[],
  transcription: Promise<VoiceTranscriptionOutcome>,
  session: { clearInFlight: () => void; flushQueue: () => void },
) {
  const delivered = deliveredCanonicalMessage(context, prepared);
  const deliveryWrite = markLocalAgentMessageDelivered(context, prepared);
  void (async () => {
    let turnStarted = false;
    try {
      const agentVoice = await transcribeAgentVoiceAttachments(attachments, transcription);
      await deliveryWrite;
      let dispatchedCanonicalMessage = delivered;
      if (agentVoice.outcome && delivered) {
        const transcribedMessage = preparedCanonicalUserMessageWithAttachments(
          delivered,
          [...agentVoice.attachments],
          agentVoice.outcome.status === 'ready' ? agentVoice.outcome.transcript : delivered.request.contentText,
        );
        dispatchedCanonicalMessage = transcribedMessage;
        context.setCanonicalSessionState((current) => replaceOptimisticCanonicalMessageContent(current, transcribedMessage));
        if (transcribedMessage) {
          // Storing the transcript only updates what is displayed; the agent receives the words directly.
          await upsertCanonicalMessageFast(transcribedMessage.request).catch((error: unknown) => {
            context.setDesktopChatError(error instanceof Error ? error.message : 'Unable to save the voice transcript');
          });
        }
      }
      const turn = await startLocalAgentTurn(context, dispatchedCanonicalMessage, agentVoice.attachments);
      if (!turn) {
        // A Kordi Cloud turn: the session is free as soon as the request is delivered.
        session.clearInFlight();
        return;
      }
      context.watchTurn(turn, localAgentNoProviderCompletion(context, dispatchedCanonicalMessage));
      // From here the turn watcher releases the session and flushes its queue when the turn ends.
      turnStarted = true;
    } catch (error) {
      session.clearInFlight();
      // The message stays delivered; the failure belongs to the agent turn.
      const failedReplyRequest = isCloudAgentNoProviderConfiguredError(error) && delivered
        ? canonicalNoProviderFailedAgentMessageRequest({
            state: context.canonicalSessionState,
            sessionId: context.canonicalSessionId,
            requestMessageId: delivered.messageId,
          })
        : null;
      if (failedReplyRequest) {
        context.setCanonicalSessionState((current) => appendCanonicalRequestToLocalState(current, failedReplyRequest));
        void appendCanonicalMessage(failedReplyRequest).catch(() => undefined);
        context.setDesktopChatError(null);
        return;
      }
      context.setDesktopChatError(error instanceof Error ? error.message : 'Unable to start the agent for this voice message');
    } finally {
      // Messages sent while this voice request waited were queued behind it; never strand them.
      if (!turnStarted) session.flushQueue();
    }
  })();
}
