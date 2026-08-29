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

function monotonicReadReceiptSummary(
  left: Message['readReceiptSummary'],
  right: Message['readReceiptSummary'],
) {
  if (!left) return right;
  if (!right) return left;
  const participantsById = new Map(left.participants.map((participant) => [participant.id, participant]));
  for (const participant of right.participants) {
    const previous = participantsById.get(participant.id);
    if (!previous || (previous.readAt ?? '') < (participant.readAt ?? '')) {
      participantsById.set(participant.id, { ...previous, ...participant });
    }
  }
  const participants = [...participantsById.values()];
  return {
    count: Math.max(left.count, right.count, participants.length),
    participants,
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

export function mergeCanonicalReadReceipts(
  messages: Message[],
  canonicalMessages: Message[],
) {
  const canonicalById = new Map<string, Message>();
  for (const message of canonicalMessages) {
    for (const id of [message.id, message.entryId]) {
      if (!id) continue;
      const previous = canonicalById.get(id);
      canonicalById.set(id, previous ? {
        ...previous,
        ...message,
        readReceiptSummary: monotonicReadReceiptSummary(
          previous.readReceiptSummary,
          message.readReceiptSummary,
        ),
      } : message);
    }
  }
  let changed = false;
  const merged = messages.map((message) => {
    const canonical = [message.id, message.entryId]
      .flatMap((id) => (id ? [canonicalById.get(id)] : []))
      .find(Boolean);
    if (!canonical) return message;
    const readReceiptSummary = monotonicReadReceiptSummary(
      message.readReceiptSummary,
      canonical.readReceiptSummary,
    );
    if (readReceiptSummariesEqual(message.readReceiptSummary, readReceiptSummary)) return message;
    changed = true;
    return { ...message, readReceiptSummary };
  });
  return changed ? merged : messages;
}
