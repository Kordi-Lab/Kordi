export function rollbackReadInboundMessageIds(
  current: Record<string, Set<string>>,
  peerId: string,
  messageIds: readonly string[],
): Record<string, Set<string>> {
  const existing = current[peerId];
  if (!existing) return current;
  const next = new Set(existing);
  for (const messageId of messageIds) next.delete(messageId);
  if (next.size === existing.size) return current;
  const result = { ...current };
  if (next.size > 0) result[peerId] = next;
  else delete result[peerId];
  return result;
}

export function addReadInboundMessageIds(
  current: Record<string, Set<string>>,
  peerId: string,
  messageIds: readonly string[],
): Record<string, Set<string>> {
  const existing = current[peerId] ?? new Set<string>();
  const next = new Set(existing);
  for (const messageId of messageIds) next.add(messageId);
  return next.size === existing.size ? current : { ...current, [peerId]: next };
}

// Highest server sequence the renderer holds per group. The cached chat head
// can lag replies this Mac published itself, and those replies are counted
// as unread until the read cursor covers them.
export function cloudGroupObservedSequences(
  groupRows: readonly { wire: { conversationSequence?: number | null }; envelope: { groupId: string } }[],
  sessionIds: readonly string[],
): Record<string, number> {
  const wanted = new Set(sessionIds);
  const sequences: Record<string, number> = {};
  for (const { wire, envelope } of groupRows) {
    const sequence = wire.conversationSequence;
    if (!wanted.has(envelope.groupId) || !Number.isSafeInteger(sequence) || sequence! <= 0) continue;
    sequences[envelope.groupId] = Math.max(sequences[envelope.groupId] ?? 0, sequence!);
  }
  return sequences;
}
