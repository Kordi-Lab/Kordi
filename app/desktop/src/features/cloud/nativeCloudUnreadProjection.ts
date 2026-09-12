import type { CloudMessage } from './authClient';

export type NativeUnreadHead = {
  latestMessageSequence: number;
  lastReadSequence: number;
  unreadCount: number;
};

export function cloudOptimisticReadSequences(
  messagesByPeer: Readonly<Record<string, readonly CloudMessage[]>>,
  readIdsByPeer: Readonly<Record<string, ReadonlySet<string>>>,
) {
  const sequences: Record<string, number> = {};
  for (const [peerId, readIds] of Object.entries(readIdsByPeer)) {
    for (const message of messagesByPeer[peerId] ?? []) {
      const sessionId = message.sessionId?.trim() || message.conversationId?.trim();
      const sequence = message.conversationSequence;
      if (!sessionId || !readIds.has(message.messageId) || !Number.isSafeInteger(sequence) || sequence! <= 0) continue;
      sequences[sessionId] = Math.max(sequences[sessionId] ?? 0, sequence!);
    }
  }
  return sequences;
}

// Native totals remain authoritative after renderer history eviction. An
// optimistic read can hide only the head it covered, never a newer arrival.
export function createNativeCloudUnreadProjection(accountId: string | null | undefined) {
  const explicitReadThrough = new Map<string, number>();
  return (
    snapshotAccountId: string,
    heads: Readonly<Record<string, NativeUnreadHead>>,
    locallyReadSessionIds: ReadonlySet<string>,
    readThrough: Readonly<Record<string, number>>,
  ): Record<string, number> | null => {
    if (!accountId || snapshotAccountId !== accountId) return null;
    for (const sessionId of explicitReadThrough.keys()) {
      if (!locallyReadSessionIds.has(sessionId)) explicitReadThrough.delete(sessionId);
    }
    for (const sessionId of locallyReadSessionIds) {
      if (!explicitReadThrough.has(sessionId) && heads[sessionId]) {
        explicitReadThrough.set(sessionId, heads[sessionId].latestMessageSequence);
      }
    }
    return Object.fromEntries(Object.entries(heads).map(([sessionId, head]) => {
      const optimisticSequence = Math.max(explicitReadThrough.get(sessionId) ?? 0, readThrough[sessionId] ?? 0);
      const read = optimisticSequence > 0 && head.latestMessageSequence <= optimisticSequence;
      return [sessionId, read ? 0 : head.unreadCount];
    }));
  };
}
