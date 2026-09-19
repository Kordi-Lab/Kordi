import type { Message } from '@/kordi-app/types';
import type { CanonicalMessageSortPosition } from './messageSort';

/**
 * Transcript entries for one mapped message. A card and PiP's words are always
 * two messages, even when an older message stored them together: the card
 * first, then the text.
 */
export function transcriptEntries(
  message: Message,
  canonical: { id: string; createdAtMs: number },
  sortPosition: CanonicalMessageSortPosition,
) {
  const createdAtMs = canonical.createdAtMs;
  if (!message.planCard || !message.text.trim()) {
    return [{ message, ...sortPosition, tieBreakAtMs: createdAtMs }];
  }
  const cardPart: Message = {
    ...message,
    id: `${message.id ?? canonical.id}#plan-card`,
    entryId: `${message.entryId ?? canonical.id}#plan-card`,
    text: '',
    mentions: undefined,
    replyToMessageId: undefined,
    replyAliasIds: undefined,
    messageAction: undefined,
    sourceMessage: undefined,
    reactionTargetMessageId: undefined,
    reactions: undefined,
  };
  return [
    { message: cardPart, ...sortPosition, tieBreakAtMs: createdAtMs - 1 },
    { message: { ...message, planCard: null }, ...sortPosition, tieBreakAtMs: createdAtMs },
  ];
}

/** Refresh card content even when the richer cached transcript remains selected. */
export function mergeCanonicalPlanCards(messages: Message[], canonicalMessages: Message[]): Message[] {
  const cardsByMessageId = new Map<string, NonNullable<Message['planCard']>>();
  for (const message of canonicalMessages) {
    if (!message.planCard) continue;
    for (const id of [message.id, message.entryId]) {
      if (id) cardsByMessageId.set(id, message.planCard);
    }
  }
  if (cardsByMessageId.size === 0) return messages;
  let changed = false;
  const merged = messages.map((message) => {
    const card = (message.id && cardsByMessageId.get(message.id))
      || (message.entryId && cardsByMessageId.get(message.entryId));
    if (!card || (message.planCard?.eventId === card.eventId && message.planCard.revision >= card.revision)) return message;
    changed = true;
    return { ...message, planCard: card };
  });
  return changed ? merged : messages;
}
