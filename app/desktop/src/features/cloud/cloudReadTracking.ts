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
