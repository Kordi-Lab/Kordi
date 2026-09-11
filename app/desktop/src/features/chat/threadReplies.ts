import type { Message } from '@/kordi-app/types';

export function mergeThreadReplies(previous: readonly Message[], incoming: readonly Message[]) {
  const messages = new Map<string, Message>();
  for (const message of [...previous, ...incoming]) {
    messages.set(message.reactionTargetMessageId ?? message.id!, message);
  }
  return [...messages.values()].sort((a, b) => {
    const aSequence = a.conversationSequence;
    const bSequence = b.conversationSequence;
    const aConfirmed = Number.isSafeInteger(aSequence) && Number(aSequence) > 0;
    const bConfirmed = Number.isSafeInteger(bSequence) && Number(bSequence) > 0;
    if (aConfirmed && bConfirmed) return Number(aSequence) - Number(bSequence);
    // A pending reply has no server sequence yet. Keep it after confirmed
    // history rather than treating it as sequence zero (the oldest reply).
    if (aConfirmed !== bConfirmed) return aConfirmed ? -1 : 1;
    return (a.timestampMs ?? 0) - (b.timestampMs ?? 0);
  });
}
