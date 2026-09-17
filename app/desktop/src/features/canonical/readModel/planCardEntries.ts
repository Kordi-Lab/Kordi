import type { Message } from '@/kordi-app/types';
import type { CanonicalMessageSortPosition } from './messageSort';

/**
 * Transcript entries for one mapped message. A card and PiP's words are always
 * two messages, even when an older message stored them together: the card
 * first, then the text.
 */
export function transcriptEntries(
  message: Message,
  canonicalId: string,
  sortPosition: CanonicalMessageSortPosition,
  createdAtMs: number,
) {
  if (!message.planCard || !message.text.trim()) {
    return [{ message, ...sortPosition, tieBreakAtMs: createdAtMs }];
  }
  const cardPart: Message = {
    ...message,
    id: `${message.id ?? canonicalId}#plan-card`,
    entryId: `${message.entryId ?? canonicalId}#plan-card`,
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
