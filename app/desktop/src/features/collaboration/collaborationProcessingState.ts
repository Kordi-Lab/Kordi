import type {
  DesktopCollaborationConversation,
  DesktopCollaborationConversationMessage,
} from '@/kordi-app/types';
import {
  COLLABORATION_MESSAGE_DIRECTION_INBOUND,
  COLLABORATION_MESSAGE_DIRECTION_INBOUND_RESPONSE,
  COLLABORATION_MESSAGE_DIRECTION_OUTBOUND,
  COLLABORATION_MESSAGE_DIRECTION_OUTBOUND_RESPONSE,
} from '@/features/collaboration/messages';
import { isProcessingPlaceholderText } from '@/features/collaboration/agentPlaceholderText';

export const COLLABORATION_PROCESSING_PLACEHOLDER_MAX_AGE_MS = 10 * 60_000;

function normalizeDeliveryState(value: string | null | undefined) {
  return value?.trim().toLowerCase() || '';
}

export function isCollaborationAgentResponseDirection(
  message: DesktopCollaborationConversationMessage,
) {
  return message.direction === COLLABORATION_MESSAGE_DIRECTION_INBOUND_RESPONSE
    || message.direction === COLLABORATION_MESSAGE_DIRECTION_OUTBOUND_RESPONSE;
}

export function isTerminalCollaborationAgentRequestState(value: string | null | undefined) {
  return ['responded', 'cancelled', 'failed', 'processing_failed', 'no_response'].includes(normalizeDeliveryState(value));
}

export function collaborationTimestampIsExpired(timestampMs: number, nowMs: number) {
  return Number.isFinite(timestampMs)
    && timestampMs > 0
    && nowMs - timestampMs >= COLLABORATION_PROCESSING_PLACEHOLDER_MAX_AGE_MS;
}

export function historicalCollaborationProcessingPlaceholderIds(
  conversation: Pick<DesktopCollaborationConversation, 'messages'>,
  nowMs: number,
  displayText: (message: DesktopCollaborationConversationMessage) => string,
) {
  const requestIdsWithBaseMessage = new Set<string>();
  for (const message of conversation.messages) {
    const requestId = message.requestId?.trim();
    if (!requestId) continue;
    if (
      message.direction === COLLABORATION_MESSAGE_DIRECTION_OUTBOUND
      || message.direction === COLLABORATION_MESSAGE_DIRECTION_INBOUND
    ) requestIdsWithBaseMessage.add(requestId);
  }

  const staleIds = new Set<string>();
  const terminalResponseRequestIds = new Set<string>();
  let hasLaterTranscriptActivity = false;
  for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
    const message = conversation.messages[index];
    const requestId = message.requestId?.trim() || null;
    const isProcessingResponse = normalizeDeliveryState(message.deliveryState) === 'processing'
      && isProcessingPlaceholderText(displayText(message))
      && isCollaborationAgentResponseDirection(message);
    if (isProcessingResponse) {
      if (
        collaborationTimestampIsExpired(message.timestampMs, nowMs)
        || (requestId && terminalResponseRequestIds.has(requestId))
        || ((!requestId || !requestIdsWithBaseMessage.has(requestId)) && hasLaterTranscriptActivity)
      ) staleIds.add(message.id);
      continue;
    }
    hasLaterTranscriptActivity = true;
    if (requestId && isCollaborationAgentResponseDirection(message)) {
      terminalResponseRequestIds.add(requestId);
    }
  }
  return staleIds;
}

export function collaborationPendingAgentReplyState(
  conversation: DesktopCollaborationConversation,
  nowMs: number,
  displayText: (message: DesktopCollaborationConversationMessage) => string,
) {
  const latestRequest = [...conversation.messages].reverse().find((message) => (
    message.direction === COLLABORATION_MESSAGE_DIRECTION_OUTBOUND
    && Boolean(message.requestId?.trim())
  ));
  const hasSentRequest = Boolean(conversation.outreach?.sourceRequestId)
    || conversation.messages.some((message) => Boolean(message.requestId));
  const staleProcessingPlaceholderIds = historicalCollaborationProcessingPlaceholderIds(conversation, nowMs, displayText);
  const awaitingReply = conversation.awaitingReply
    && hasSentRequest
    && !isTerminalCollaborationAgentRequestState(latestRequest?.deliveryState)
    && !(latestRequest?.timestampMs && collaborationTimestampIsExpired(latestRequest.timestampMs, nowMs));
  const pendingAgentMention = awaitingReply
    ? latestRequest?.mentions?.find((mention) => mention.targetKind === 'agent')
    : undefined;
  const activeAgentReplyMessage = awaitingReply
    ? [...conversation.messages].reverse().find((message) => (
        isCollaborationAgentResponseDirection(message)
        && normalizeDeliveryState(message.deliveryState) === 'processing'
        && !staleProcessingPlaceholderIds.has(message.id)
      ))
    : undefined;
  return { activeAgentReplyMessage, awaitingReply, hasSentRequest, pendingAgentMention, staleProcessingPlaceholderIds };
}
