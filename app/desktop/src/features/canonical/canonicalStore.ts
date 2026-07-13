import type {
  CanonicalMessagePage,
  CanonicalSessionCatalog,
  CanonicalSessionMessage,
  CanonicalSessionState,
} from '@/kordi-app/types';

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

function isReadableCanonicalMessage(message: CanonicalSessionMessage) {
  return !['canonical-fork-snapshot', 'cloud-group-fork-snapshot'].includes(message.sourceTransport ?? '')
    && !['sending', 'processing'].includes(message.status.trim().toLowerCase());
}

function mergeMessages(
  existing: readonly CanonicalSessionMessage[],
  incoming: readonly CanonicalSessionMessage[],
) {
  if (incoming.length === 0) return [...existing];
  const byId = new Map(existing.map((message) => [message.id, message]));
  for (const message of incoming) {
    const previous = byId.get(message.id);
    if (!previous || message.updatedAtMs >= previous.updatedAtMs) byId.set(message.id, message);
  }
  return [...byId.values()].sort(compareCanonicalMessages);
}

export function mergeCanonicalCatalog(
  store: CanonicalStore,
  catalog: CanonicalSessionCatalog,
): CanonicalStore {
  const sessionIds = new Set(catalog.sessions.map((session) => session.id));
  const messagesBySessionId: Record<string, CanonicalSessionMessage[]> = {};
  const hydrationBySessionId: Record<string, SessionHydrationState> = {};
  const hasOlderBySessionId: Record<string, boolean> = {};
  const summaryBySessionId = new Map(catalog.summaries.map((summary) => [summary.sessionId, summary]));

  for (const sessionId of sessionIds) {
    const previousMessages = store.messagesBySessionId[sessionId] ?? [];
    const latestMessage = summaryBySessionId.get(sessionId)?.latestMessage;
    messagesBySessionId[sessionId] = latestMessage
      ? mergeMessages(previousMessages, [latestMessage])
      : [...previousMessages];
    hydrationBySessionId[sessionId] = store.hydrationBySessionId[sessionId] ?? 'cold';
    hasOlderBySessionId[sessionId] = Boolean(store.hasOlderBySessionId[sessionId])
      || ((summaryBySessionId.get(sessionId)?.messageCount ?? 0) > messagesBySessionId[sessionId].length);
  }

  return { catalog, messagesBySessionId, hydrationBySessionId, hasOlderBySessionId };
}

export function beginCanonicalSessionHydration(store: CanonicalStore, sessionId: string): CanonicalStore {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) return store;
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
      [sessionId]: page.messages.length === 0 && existing.length > 0
        ? (store.hasOlderBySessionId[sessionId] ?? page.hasOlder)
        : page.hasOlder,
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
    if (!isReadableCanonicalMessage(message)) return latest;
    return !latest || compareCanonicalMessages(latest, message) < 0 ? message : latest;
  }, null);
}

export function mergeCanonicalStateIntoStore(
  store: CanonicalStore,
  state: CanonicalSessionState | null,
): CanonicalStore {
  if (!state) return createCanonicalStore();
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
      (count, message) => count + Number(isReadableCanonicalMessage(message)),
      0,
    );
    const containsCompleteReadableHistory = incomingReadableCount >= (previous?.messageCount ?? 0);
    const readableDelta = messages.reduce((delta, message) => {
      if (!isReadableCanonicalMessage(message)) return delta;
      return delta + Number(!previousById.has(message.id) || !isReadableCanonicalMessage(previousById.get(message.id)!));
    }, 0) - previousMessages.reduce((delta, message) => {
      if (!isReadableCanonicalMessage(message)) return delta;
      const next = nextById.get(message.id);
      return delta + Number(!next || !isReadableCanonicalMessage(next));
    }, 0);
    const messageCount = containsCompleteReadableHistory
      ? incomingReadableCount
      : Math.max(0, (previous?.messageCount ?? 0) + readableDelta);
    const incomingLatest = latestReadableMessage(messages);
    const previousLatestInNext = previous?.latestMessage
      ? nextById.get(previous.latestMessage.id)
      : null;
    const previousLatestStillReadable = previousLatestInNext
      ? isReadableCanonicalMessage(previousLatestInNext)
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
  return {
    ...catalogMerged,
    messagesBySessionId: Object.fromEntries(state.sessions.map((session) => [
      session.id,
      messagesBySessionId[session.id] ?? catalogMerged.messagesBySessionId[session.id] ?? [],
    ])),
  };
}
