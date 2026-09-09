import type { CanonicalStore } from './canonicalStore';
import type { CanonicalSessionMessage } from '@/kordi-app/types';
import { canonicalMessageReactionMetadata } from './readModel/messageReactionMetadata';
import { canonicalMessageCountsAsReadable } from './readModel/messageVisibility';

export function filterDeletedCanonicalStore(store: CanonicalStore, removed: ReadonlySet<string>): CanonicalStore {
  if (removed.size === 0) return store;
  const isRemoved = (message: CanonicalSessionMessage) => {
    const content = message.content && typeof message.content === 'object' && !Array.isArray(message.content)
      ? message.content as Record<string, unknown> : {};
    const target = canonicalMessageReactionMetadata(message, content, message.sourceTransport ?? '').reactionTargetMessageId;
    return Boolean(target && removed.has(target));
  };
  let changed = false;
  const removedCounts = new Map<string, number>();
  const messagesBySessionId = Object.fromEntries(Object.entries(store.messagesBySessionId).map(([sessionId, messages]) => {
    const kept = messages.filter((message) => !isRemoved(message));
    if (kept.length === messages.length) return [sessionId, messages];
    changed = true;
    removedCounts.set(sessionId, messages.filter((message) => isRemoved(message) && canonicalMessageCountsAsReadable(message)).length);
    return [sessionId, kept];
  }));
  const summaries = store.catalog?.summaries.map((summary) => {
    const latestRemoved = summary.latestMessage && isRemoved(summary.latestMessage);
    const count = removedCounts.get(summary.sessionId) ?? Number(Boolean(latestRemoved));
    if (!latestRemoved && count === 0) return summary;
    changed = true;
    return {
      ...summary,
      messageCount: Math.max(0, summary.messageCount - count),
      latestMessage: latestRemoved
        ? (messagesBySessionId[summary.sessionId] ?? []).filter(canonicalMessageCountsAsReadable).slice(-1)[0] ?? null
        : summary.latestMessage,
    };
  });
  return changed ? {
    ...store,
    messagesBySessionId,
    catalog: store.catalog && summaries ? { ...store.catalog, summaries } : store.catalog,
  } : store;
}
