import type { Message } from '@/kordi-app/types';

export type CanonicalMessageSortPosition = {
  sortAtMs: number;
  sequenceNum: number;
};

export type SortableCanonicalMessage = CanonicalMessageSortPosition & {
  message: Message;
  tieBreakAtMs: number;
};

export function sortedCanonicalMessages(messages: SortableCanonicalMessage[]) {
  return [...messages]
    .sort((left, right) => left.sortAtMs - right.sortAtMs
      || left.sequenceNum - right.sequenceNum
      || left.tieBreakAtMs - right.tieBreakAtMs
      || ((left.message.id ?? '') < (right.message.id ?? '') ? -1 : (left.message.id ?? '') > (right.message.id ?? '') ? 1 : 0))
    .map((entry) => entry.message);
}
