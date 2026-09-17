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
