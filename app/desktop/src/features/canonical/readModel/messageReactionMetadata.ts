import type { CanonicalSessionMessage, Message } from '@/kordi-app/types';

export function canonicalMessageReactionMetadata(
  message: CanonicalSessionMessage,
  content: Record<string, unknown>,
  sourceTransport: string,
): Pick<Message, 'reactionConversationId' | 'reactionTargetMessageId'> {
  if (!sourceTransport.startsWith('cloud')) {
    return { reactionConversationId: null, reactionTargetMessageId: null };
  }
  const contentMessageId = typeof content.cloudGroupMessageId === 'string'
    ? content.cloudGroupMessageId.trim()
    : '';
  const targetMessageId = contentMessageId || (
    sourceTransport.startsWith('cloud-group')
      ? message.id
      : message.sourceEventId?.trim() || message.id
  );
  return {
    reactionConversationId: targetMessageId ? message.sessionId : null,
    reactionTargetMessageId: targetMessageId || null,
  };
}

function readReceiptSummariesEqual(
  left: Message['readReceiptSummary'],
  right: Message['readReceiptSummary'],
) {
  if (!left || !right) return left === right;
  return left.count === right.count
    && left.participants.length === right.participants.length
    && left.participants.every((participant, index) => {
      const other = right.participants[index];
      return participant.id === other?.id
        && participant.name === other.name
        && participant.avatarSeed === other.avatarSeed
        && participant.profileImageUrl === other.profileImageUrl
        && participant.readAt === other.readAt;
    });
}

export function mergedMessageReactionMetadata(message: Message, canonicalMessage: Message) {
  const reactionConversationId = message.reactionConversationId ?? canonicalMessage.reactionConversationId;
  const reactionTargetMessageId = message.reactionTargetMessageId ?? canonicalMessage.reactionTargetMessageId;
  return {
    changed: reactionConversationId !== message.reactionConversationId
      || reactionTargetMessageId !== message.reactionTargetMessageId,
    values: {
      ...(reactionConversationId ? { reactionConversationId } : {}),
      ...(reactionTargetMessageId ? { reactionTargetMessageId } : {}),
    },
  };
}

export function mergeCanonicalReadReceipts(
  messages: Message[],
  canonicalMessages: Message[],
) {
  const canonicalById = new Map(canonicalMessages.flatMap((message) => (
    [message.id, message.entryId]
      .filter((id): id is string => Boolean(id))
      .map((id) => [id, message] as const)
  )));
  let changed = false;
  const merged = messages.map((message) => {
    const canonical = [message.id, message.entryId]
      .flatMap((id) => (id ? [canonicalById.get(id)] : []))
      .find(Boolean);
    if (
      !canonical?.readReceiptSummary
      || readReceiptSummariesEqual(
        message.readReceiptSummary,
        canonical.readReceiptSummary,
      )
    ) return message;
    changed = true;
    return { ...message, readReceiptSummary: canonical.readReceiptSummary };
  });
  return changed ? merged : messages;
}
