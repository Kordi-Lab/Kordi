import type { Message } from '@/kordi-app/types';

export type OutgoingOrder = ReadonlyMap<string, number>;

function identities(message: Message): string[] {
  return [message.clientMessageId, message.id, message.entryId]
    .map((value) => value?.trim()).filter((value): value is string => Boolean(value));
}

/** Retain the order in which local sends first appeared, across server acknowledgements. */
export function preserveOutgoingTranscriptOrder(
  previous: OutgoingOrder | undefined,
  messages: Message[],
): { messages: Message[]; order: OutgoingOrder } {
  const order = new Map<string, number>();
  let nextPosition = 0;
  for (const position of previous?.values() ?? []) nextPosition = Math.max(nextPosition, position + 1);
  const tracked: Array<{ index: number; position: number; message: Message }> = [];
  messages.forEach((message, index) => {
    if (!message.isOwnMessage && message.role !== 'user') return;
    const keys = identities(message);
    if (keys.length === 0) return;
    const known = keys.map((key) => previous?.get(key)).find((value) => value !== undefined);
    const pending = message.statusChips?.some((status) => ['sending', 'queued', 'pending'].includes(status));
    if (known === undefined && !pending) return;
    const position = known ?? nextPosition++;
    keys.forEach((key) => order.set(key, position));
    tracked.push({ index, position, message });
  });
  // Only local sends exchange slots. Incoming messages, history and agent
  // placement keep their authoritative positions. Metadata and receipts stay fresh.
  const sorted = [...tracked].sort((left, right) => left.position - right.position);
  if (tracked.every((item, index) => item === sorted[index])) return { messages, order };
  const ordered = [...messages];
  tracked.forEach((item, index) => { ordered[item.index] = sorted[index].message; });
  return { messages: ordered, order };
}
