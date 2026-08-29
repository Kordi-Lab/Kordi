import type { CanonicalSessionMessage, Message } from '@/kordi-app/types';
import {
  cloudReactionsEqual,
  normalizeCloudMessageReactions,
} from '@/features/cloud/cloudMessageMerge';

export function canonicalMessageReactionMetadata(
  message: CanonicalSessionMessage,
  content: Record<string, unknown>,
  sourceTransport: string,
): Pick<Message, 'reactionConversationId' | 'reactionTargetMessageId' | 'reactions'> {
  if (!sourceTransport.startsWith('cloud')) {
    return { reactionConversationId: null, reactionTargetMessageId: null };
  }
  const contentMessageId = typeof content.cloudGroupMessageId === 'string'
    ? content.cloudGroupMessageId.trim()
    : '';
  const reactionConversationId = typeof content.cloudReactionConversationId === 'string'
    ? content.cloudReactionConversationId.trim()
    : '';
  const reactionTargetMessageId = typeof content.cloudReactionTargetMessageId === 'string'
    ? content.cloudReactionTargetMessageId.trim()
    : '';
  const sourceEventPrefix = `${sourceTransport}:`;
  const sourceEventMessageId = sourceTransport.startsWith('cloud-group')
    && message.sourceEventId?.startsWith(sourceEventPrefix)
    ? message.sourceEventId.slice(sourceEventPrefix.length).split(':', 1)[0]?.trim() ?? ''
    : '';
  const sourceMessageId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(sourceEventMessageId)
    ? sourceEventMessageId
    : '';
  const targetMessageId = reactionTargetMessageId || sourceMessageId || contentMessageId || (
    sourceTransport.startsWith('cloud-group')
      ? message.id
      : message.sourceEventId?.trim() || message.id
  );
  const reactions = normalizeCloudMessageReactions(content.reactions);
  return {
    reactionConversationId: targetMessageId
      ? reactionConversationId || message.sessionId
      : null,
    reactionTargetMessageId: targetMessageId || null,
    ...(reactions ? { reactions } : {}),
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
  const messageReactions = 'reactions' in message ? message.reactions : undefined;
  const reactions = 'reactions' in canonicalMessage
    ? canonicalMessage.reactions
    : messageReactions;
  return {
    changed: reactionConversationId !== message.reactionConversationId
      || reactionTargetMessageId !== message.reactionTargetMessageId
      || ((messageReactions !== undefined || reactions !== undefined)
        && !cloudReactionsEqual(messageReactions, reactions)),
    values: {
      ...(reactionConversationId ? { reactionConversationId } : {}),
      ...(reactionTargetMessageId ? { reactionTargetMessageId } : {}),
      ...(reactions !== undefined ? { reactions } : {}),
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
