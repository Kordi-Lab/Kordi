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
