import type {
  CanonicalMessagePage,
  CanonicalSessionCatalog,
  CanonicalSessionMessage,
  CanonicalSessionState,
} from '@/kordi-app/types';
import { canonicalMessageCountsAsReadable } from './readModel/messageVisibility';
import {
  canonicalJsonValuesEqual,
  canonicalMessagesEqual,
} from './canonicalEquality';

export type SessionHydrationState = 'cold' | 'loading' | 'ready' | 'error';

export type CanonicalStore = {
  catalog: CanonicalSessionCatalog | null;
  messagesBySessionId: Record<string, CanonicalSessionMessage[]>;
  hydrationBySessionId: Record<string, SessionHydrationState>;
  hasOlderBySessionId: Record<string, boolean>;
};

export function createCanonicalStore(): CanonicalStore {
  return {
    catalog: null,
    messagesBySessionId: {},
    hydrationBySessionId: {},
    hasOlderBySessionId: {},
  };
}

function compareCanonicalMessages(left: CanonicalSessionMessage, right: CanonicalSessionMessage) {
  return left.sequenceNum - right.sequenceNum
    || left.createdAtMs - right.createdAtMs
    || left.id.localeCompare(right.id);
}

function mergeMessages(
  existing: CanonicalSessionMessage[],
  incoming: readonly CanonicalSessionMessage[],
) {
  if (incoming.length === 0) return existing;
  const byId = new Map(existing.map((message) => [message.id, message]));
  let changed = false;
  for (const message of incoming) {
    const previous = byId.get(message.id);
    if (!previous) {
      byId.set(message.id, message);
      changed = true;
      continue;
    }
    if (
      message.updatedAtMs >= previous.updatedAtMs
      && !canonicalMessagesEqual(previous, message)
    ) {
      byId.set(message.id, message);
      changed = true;
    }
  }
  if (!changed) return existing;
  const merged = [...byId.values()].sort(compareCanonicalMessages);
  return merged.length === existing.length
    && merged.every((message, index) => message === existing[index])
    ? existing
    : merged;
}

function recordsMatch<T>(
  existing: Readonly<Record<string, T>>,
  incoming: Readonly<Record<string, T>>,
): boolean {
  const existingKeys = Object.keys(existing);
  const incomingKeys = Object.keys(incoming);
  return existingKeys.length === incomingKeys.length
    && incomingKeys.every((key) => existing[key] === incoming[key]);
}

export function mergeCanonicalCatalog(
  store: CanonicalStore,
  catalog: CanonicalSessionCatalog,
): CanonicalStore {
  const stableCatalog = store.catalog
    && canonicalJsonValuesEqual(store.catalog, catalog)
    ? store.catalog
    : catalog;
  const sessionIds = new Set(stableCatalog.sessions.map((session) => session.id));
  const messagesBySessionId: Record<string, CanonicalSessionMessage[]> = {};
  const hydrationBySessionId: Record<string, SessionHydrationState> = {};
  const hasOlderBySessionId: Record<string, boolean> = {};
  const summaryBySessionId = new Map(stableCatalog.summaries.map((summary) => [summary.sessionId, summary]));

  for (const sessionId of sessionIds) {
    const previousMessages = store.messagesBySessionId[sessionId] ?? [];
    const latestMessage = summaryBySessionId.get(sessionId)?.latestMessage;
    messagesBySessionId[sessionId] = latestMessage
      ? mergeMessages(previousMessages, [latestMessage])
      : previousMessages;
    hydrationBySessionId[sessionId] = store.hydrationBySessionId[sessionId] ?? 'cold';
    hasOlderBySessionId[sessionId] = Boolean(store.hasOlderBySessionId[sessionId])
      || ((summaryBySessionId.get(sessionId)?.messageCount ?? 0) > messagesBySessionId[sessionId].length);
  }

  const stableMessages = recordsMatch(store.messagesBySessionId, messagesBySessionId)
    ? store.messagesBySessionId
    : messagesBySessionId;
  const stableHydration = recordsMatch(store.hydrationBySessionId, hydrationBySessionId)
    ? store.hydrationBySessionId
    : hydrationBySessionId;
  const stableHasOlder = recordsMatch(store.hasOlderBySessionId, hasOlderBySessionId)
    ? store.hasOlderBySessionId
    : hasOlderBySessionId;
  if (
    stableCatalog === store.catalog
    && stableMessages === store.messagesBySessionId
    && stableHydration === store.hydrationBySessionId
    && stableHasOlder === store.hasOlderBySessionId
  ) return store;
  return {
    catalog: stableCatalog,
    messagesBySessionId: stableMessages,
    hydrationBySessionId: stableHydration,
    hasOlderBySessionId: stableHasOlder,
  };
}

export function beginCanonicalSessionHydration(store: CanonicalStore, sessionId: string): CanonicalStore {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) return store;
  if (store.hydrationBySessionId[normalizedSessionId] === 'loading') return store;
  return {
    ...store,
    hydrationBySessionId: {
      ...store.hydrationBySessionId,
      [normalizedSessionId]: 'loading',
    },
  };
}

export function failCanonicalSessionHydration(store: CanonicalStore, sessionId: string): CanonicalStore {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) return store;
  if (store.hydrationBySessionId[normalizedSessionId] === 'error') return store;
  return {
    ...store,
    hydrationBySessionId: {
      ...store.hydrationBySessionId,
      [normalizedSessionId]: 'error',
    },
  };
}

export function mergeCanonicalMessagePage(store: CanonicalStore, page: CanonicalMessagePage): CanonicalStore {
  const sessionId = page.sessionId.trim();
  if (!sessionId) return store;
  const existing = store.messagesBySessionId[sessionId] ?? [];
  const messages = mergeMessages(existing, page.messages.filter((message) => message.sessionId === sessionId));
  if (
    messages === existing
    && store.hydrationBySessionId[sessionId] === 'ready'
    && store.hasOlderBySessionId[sessionId] === page.hasOlder
  ) return store;
  return {
    ...store,
    messagesBySessionId: {
      ...store.messagesBySessionId,
      [sessionId]: messages,
    },
    hydrationBySessionId: {
      ...store.hydrationBySessionId,
      [sessionId]: 'ready',
    },
    hasOlderBySessionId: {
      ...store.hasOlderBySessionId,
      // An empty page is the authoritative end-of-history result. Keep the
      // already-loaded rows, but clear stale pagination state so a viewport at
      // the top cannot request the same empty page forever.
      [sessionId]: page.hasOlder,
    },
  };
}

export function canonicalStateFromStore(store: CanonicalStore): CanonicalSessionState | null {
  if (!store.catalog) return null;
  const sessionOrder = new Map(store.catalog.sessions.map((session, index) => [session.id, index]));
  const messages = Object.values(store.messagesBySessionId)
    .flat()
    .sort((left, right) => (
      (sessionOrder.get(left.sessionId) ?? Number.MAX_SAFE_INTEGER)
        - (sessionOrder.get(right.sessionId) ?? Number.MAX_SAFE_INTEGER)
      || compareCanonicalMessages(left, right)
    ));
  const { summaries: _summaries, ...catalog } = store.catalog;
  return {
    ...catalog,
    messages,
    contextSnapshots: [],
  };
}

export type CanonicalSessionStateAction = CanonicalSessionState | null | (
  (current: CanonicalSessionState | null) => CanonicalSessionState | null
);

export function applyCanonicalSessionStateAction(
  store: CanonicalStore,
  action: CanonicalSessionStateAction,
): CanonicalStore {
  const currentState = canonicalStateFromStore(store);
  const nextState = typeof action === 'function' ? action(currentState) : action;
  return nextState === currentState ? store : mergeCanonicalStateIntoStore(store, nextState);
}

function latestReadableMessage(messages: readonly CanonicalSessionMessage[]) {
  return messages.reduce<CanonicalSessionMessage | null>((latest, message) => {
    if (!canonicalMessageCountsAsReadable(message)) return latest;
    return !latest || compareCanonicalMessages(latest, message) < 0 ? message : latest;
  }, null);
}

export function mergeCanonicalStateIntoStore(
  store: CanonicalStore,
  state: CanonicalSessionState | null,
): CanonicalStore {
  if (!state) {
    return store.catalog === null
      && Object.keys(store.messagesBySessionId).length === 0
      ? store
      : createCanonicalStore();
  }
  const messagesBySessionId = state.messages.reduce<Record<string, CanonicalSessionMessage[]>>((grouped, message) => {
    const sessionId = message.sessionId.trim();
    if (!sessionId) return grouped;
    (grouped[sessionId] ??= []).push(message);
    return grouped;
  }, {});
  Object.values(messagesBySessionId).forEach((messages) => messages.sort(compareCanonicalMessages));
  const previousSummaryBySessionId = new Map(store.catalog?.summaries.map((summary) => [summary.sessionId, summary]) ?? []);
  const contextSnapshotCountBySessionId = state.contextSnapshots.reduce<Record<string, number>>((counts, snapshot) => {
    counts[snapshot.sessionId] = (counts[snapshot.sessionId] ?? 0) + 1;
    return counts;
  }, {});
  const summaries = state.sessions.map((session) => {
    const messages = messagesBySessionId[session.id] ?? [];
    const previous = previousSummaryBySessionId.get(session.id);
    const previousMessages = store.messagesBySessionId[session.id] ?? [];
    const previousById = new Map(previousMessages.map((message) => [message.id, message]));
    const nextById = new Map(messages.map((message) => [message.id, message]));
    const incomingReadableCount = messages.reduce(
      (count, message) => count + Number(canonicalMessageCountsAsReadable(message)),
      0,
    );
    const containsCompleteReadableHistory = incomingReadableCount >= (previous?.messageCount ?? 0);
    const readableDelta = messages.reduce((delta, message) => {
      if (!canonicalMessageCountsAsReadable(message)) return delta;
      return delta + Number(!previousById.has(message.id) || !canonicalMessageCountsAsReadable(previousById.get(message.id)!));
    }, 0) - previousMessages.reduce((delta, message) => {
      if (!canonicalMessageCountsAsReadable(message)) return delta;
      const next = nextById.get(message.id);
      return delta + Number(!next || !canonicalMessageCountsAsReadable(next));
    }, 0);
    const messageCount = containsCompleteReadableHistory
      ? incomingReadableCount
      : Math.max(0, (previous?.messageCount ?? 0) + readableDelta);
    const incomingLatest = latestReadableMessage(messages);
    const previousLatestInNext = previous?.latestMessage
      ? nextById.get(previous.latestMessage.id)
      : null;
    const previousLatestStillReadable = previousLatestInNext
      ? canonicalMessageCountsAsReadable(previousLatestInNext)
      : false;
    const latestMessage = containsCompleteReadableHistory || !previousLatestStillReadable
      ? incomingLatest
      : incomingLatest && previous?.latestMessage
        ? (compareCanonicalMessages(previous.latestMessage, incomingLatest) < 0 ? incomingLatest : previous.latestMessage)
        : previous?.latestMessage ?? incomingLatest;
    return {
      sessionId: session.id,
      messageCount,
      latestMessage,
      contextSnapshotCount: Math.max(
        previous?.contextSnapshotCount ?? 0,
        contextSnapshotCountBySessionId[session.id] ?? 0,
      ),
    };
  });
  const catalog: CanonicalSessionCatalog = {
    storagePath: state.storagePath,
    profile: state.profile,
    identities: state.identities,
    sessions: state.sessions,
    participants: state.participants,
    delegatedExchanges: state.delegatedExchanges,
    presence: state.presence,
    summaries,
  };
  const catalogMerged = mergeCanonicalCatalog(store, catalog);
  const nextMessagesBySessionId = Object.fromEntries(
    state.sessions.map((session) => {
      const incoming = messagesBySessionId[session.id] ?? [];
      const existing = catalogMerged.messagesBySessionId[session.id] ?? [];
      const stable = existing.length === incoming.length
        && existing.every((message, index) => (
          canonicalMessagesEqual(message, incoming[index])
        ))
        ? existing
        : incoming;
      return [session.id, stable];
    }),
  );
  if (recordsMatch(catalogMerged.messagesBySessionId, nextMessagesBySessionId)) {
    return catalogMerged;
  }
  return {
    ...catalogMerged,
    messagesBySessionId: nextMessagesBySessionId,
  };
}
