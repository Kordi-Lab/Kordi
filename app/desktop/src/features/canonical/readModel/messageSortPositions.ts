import type { CanonicalSessionMessage, CanonicalSessionState } from '@/kordi-app/types';
import type { CanonicalMessageSortPosition } from './messageSort';
import { contentRecord, stringValue } from './messageMapping';

export function messageSortPosition(message: CanonicalSessionMessage): CanonicalMessageSortPosition {
  return { sortAtMs: message.createdAtMs, sequenceNum: message.sequenceNum };
}

const CHILD_MESSAGE_SEQUENCE_OFFSET = 0.5;

function childMessageSortPosition(
  message: CanonicalSessionMessage,
  rawMessageById: ReadonlyMap<string, CanonicalSessionMessage>,
  messageSortById: Map<string, CanonicalMessageSortPosition>,
  visitingMessageIds: Set<string>,
): CanonicalMessageSortPosition {
  const cachedPosition = messageSortById.get(message.id);
  if (cachedPosition) return cachedPosition;

  const basePosition = messageSortPosition(message);
  if (!message.parentMessageId || message.parentMessageId === message.id || visitingMessageIds.has(message.id)) {
    messageSortById.set(message.id, basePosition);
    return basePosition;
  }

  const parentMessage = rawMessageById.get(message.parentMessageId);
  if (!parentMessage) {
    messageSortById.set(message.id, basePosition);
    return basePosition;
  }

  visitingMessageIds.add(message.id);
  const parentPosition = childMessageSortPosition(parentMessage, rawMessageById, messageSortById, visitingMessageIds);
  visitingMessageIds.delete(message.id);
  const isAlreadyAfterParent = basePosition.sortAtMs > parentPosition.sortAtMs
    || (
      basePosition.sortAtMs === parentPosition.sortAtMs
      && basePosition.sequenceNum > parentPosition.sequenceNum
    );
  const selfAgentRequestReply = message.sourceTransport === 'cloud-self-agent'
    && message.senderRole === 'owned-agent' && parentMessage.senderRole === 'user'
    && Boolean(stringValue(contentRecord(message.content).cloudRequestMessageId)?.trim());
  // Hosted turn replies stay beside their request, including migrated rows
  // whose immutable timestamp predates the restored request alias.
  // Other parent links retain chronology and only clamp clock drift.
  const position = selfAgentRequestReply
    ? { sortAtMs: parentPosition.sortAtMs + 1, sequenceNum: parentPosition.sequenceNum + CHILD_MESSAGE_SEQUENCE_OFFSET }
    : isAlreadyAfterParent
    ? basePosition
    : {
        sortAtMs: parentPosition.sortAtMs,
        sequenceNum: parentPosition.sequenceNum + CHILD_MESSAGE_SEQUENCE_OFFSET,
      };
  messageSortById.set(message.id, position);
  return position;
}

export function buildMessageSortPositions(messages: CanonicalSessionMessage[]) {
  const rawMessageById = new Map(messages.map((message) => [message.id, message]));
  const messageSortById = new Map<string, CanonicalMessageSortPosition>();
  for (const message of messages) {
    childMessageSortPosition(message, rawMessageById, messageSortById, new Set());
  }
  return messageSortById;
}

export function exchangeSortPosition(
  exchange: CanonicalSessionState['delegatedExchanges'][number],
  messageSortById: Map<string, CanonicalMessageSortPosition>,
): CanonicalMessageSortPosition {
  const parentMessageId = exchange.requestMessageId?.trim() || exchange.triggerMessageId?.trim();
  const parentPosition = parentMessageId ? messageSortById.get(parentMessageId) : null;
  if (parentPosition) {
    return {
      sortAtMs: parentPosition.sortAtMs,
      sequenceNum: parentPosition.sequenceNum + 0.5,
    };
  }
  return { sortAtMs: exchange.createdAtMs, sequenceNum: Number.MAX_SAFE_INTEGER };
}
