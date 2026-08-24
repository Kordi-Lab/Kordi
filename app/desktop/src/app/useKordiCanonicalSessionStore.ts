import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';

import {
  applyCanonicalSessionStateAction,
  beginCanonicalSessionHydration,
  canonicalStateFromStore,
  createCanonicalStore,
  failCanonicalSessionHydration,
  mergeCanonicalCatalog,
  mergeCanonicalMessagePage,
  retainCanonicalSessionPages,
  type CanonicalStore,
} from '@/features/canonical/canonicalStore';
import type {
  CanonicalMessagePage,
  CanonicalSessionState,
  DesktopCollaborationState,
} from '@/kordi-app/types';
import {
  fetchCanonicalSessionCatalog,
  fetchCanonicalSessionMessages,
} from '@/lib/desktop';
import {
  createSingleFlightState,
  requestSingleFlightRun,
} from '@/lib/singleFlight';
import {
  stripDerivedCloudUnreadCounts,
  uniqueStrings,
} from '@/app/useKordiAppModelHelpers';
import {
  cloudPeerAccountIdFromConversationId,
  cloudSessionIdFromConversationId,
  isCloudCollaborationConversationId,
} from '@/features/collaboration/conversationIds';
import {
  KORDI_SUPPORT_ACCOUNT_ID,
  KORDI_SUPPORT_AGENT_ID,
} from '@/features/support/supportIdentity';

const CANONICAL_MESSAGE_PAGE_SIZE = 50;
const CANONICAL_SESSION_PAGE_CACHE_LIMIT = 8;

function recentCanonicalSessionIds(
  current: readonly string[],
  sessionId: string,
) {
  if (!sessionId || current[current.length - 1] === sessionId) return current;
  return [...current.filter((id) => id !== sessionId), sessionId]
    .slice(-CANONICAL_SESSION_PAGE_CACHE_LIMIT);
}

export function resolveCanonicalPageSessionId(
  candidate: string | null | undefined,
  catalogSessionIds: ReadonlySet<string>,
  conversations: DesktopCollaborationState['conversations'] = [],
) {
  const id = candidate?.trim() ?? '';
  if (!id) return null;
  if (catalogSessionIds.has(id)) return id;
  const matchedConversation = conversations.find((conversation) => (
    conversation.id === id
    || conversation.canonicalSessionId === id
  ));
  const matchedSessionId = matchedConversation?.canonicalSessionId?.trim();
  if (matchedSessionId && catalogSessionIds.has(matchedSessionId)) {
    return matchedSessionId;
  }
  if (
    !isCloudCollaborationConversationId(id)
    || cloudSessionIdFromConversationId(id)
  ) {
    return null;
  }
  const peerAccountId = cloudPeerAccountIdFromConversationId(id);
  const exactSupportConversation = conversations.find((conversation) => (
    conversation.supportTicketEnabled
    && conversation.peerNodeId === peerAccountId
  ));
  const legacySupportConversation = exactSupportConversation
    ?? (peerAccountId === KORDI_SUPPORT_ACCOUNT_ID
      ? conversations.find((conversation) => (
          conversation.supportTicketEnabled
          && conversation.identity?.remoteAgentId === KORDI_SUPPORT_AGENT_ID
        ))
      : undefined);
  const legacySupportSessionId = legacySupportConversation?.canonicalSessionId?.trim();
  return legacySupportSessionId
    && catalogSessionIds.has(legacySupportSessionId)
    ? legacySupportSessionId
    : null;
}

export function useKordiCanonicalSessionStore({
  accountId,
  isNativeShell,
}: {
  accountId: string | null;
  isNativeShell: boolean;
}) {
  const [store, setStoreValue] = useState<CanonicalStore>(
    () => createCanonicalStore(),
  );
  const storeRef = useRef(store);
  const refreshFlightRef = useRef(createSingleFlightState());
  const pageFlightsRef = useRef(
    new Map<string, Promise<CanonicalMessagePage | null>>(),
  );
  const recentPageSessionIdsRef = useRef<readonly string[]>([]);
  const [
    initialRefreshSettled,
    setInitialRefreshSettled,
  ] = useState(!isNativeShell);
  const [
    initialRefreshError,
    setInitialRefreshError,
  ] = useState(false);

  const updateStore = useCallback((
    action: SetStateAction<CanonicalStore>,
  ) => {
    const current = storeRef.current;
    const next = typeof action === 'function'
      ? action(current)
      : action;
    if (Object.is(next, current)) return;
    storeRef.current = next;
    setStoreValue(next);
  }, []);

  const { catalog, messagesBySessionId } = store;
  const state = useMemo(() => canonicalStateFromStore({
    catalog,
    messagesBySessionId,
    hydrationBySessionId: {},
    hasOlderBySessionId: {},
  }), [catalog, messagesBySessionId]);
  const setState = useCallback<Dispatch<
    SetStateAction<CanonicalSessionState | null>
  >>((action) => {
    const retained = new Set(recentPageSessionIdsRef.current);
    updateStore((currentStore) => retainCanonicalSessionPages(
      applyCanonicalSessionStateAction(currentStore, action),
      retained,
    ));
  }, [updateStore]);

  const hydrateSessionPage = useCallback((
    sessionId: string,
    options: {
      beforeSequenceNum?: number | null;
      force?: boolean;
    } = {},
  ) => {
    const normalizedSessionId = sessionId.trim();
    if (!isNativeShell || !normalizedSessionId) {
      return Promise.resolve(null);
    }
    recentPageSessionIdsRef.current = recentCanonicalSessionIds(
      recentPageSessionIdsRef.current,
      normalizedSessionId,
    );
    const retained = new Set(recentPageSessionIdsRef.current);
    const beforeSequenceNum = options.beforeSequenceNum ?? null;
    const flightKey =
      `${normalizedSessionId}:${beforeSequenceNum ?? 'latest'}`;
    const existingFlight = pageFlightsRef.current.get(flightKey);
    if (existingFlight) return existingFlight;
    const currentStore = storeRef.current;
    const hydration =
      currentStore.hydrationBySessionId[normalizedSessionId]
      ?? 'cold';
    if (
      beforeSequenceNum === null
      && hydration === 'ready'
      && !options.force
    ) {
      updateStore((current) => retainCanonicalSessionPages(current, retained));
      return Promise.resolve(null);
    }

    if (beforeSequenceNum === null) {
      updateStore((current) => retainCanonicalSessionPages(
        beginCanonicalSessionHydration(current, normalizedSessionId),
        retained,
      ));
    }
    const request = fetchCanonicalSessionMessages(
      normalizedSessionId,
      beforeSequenceNum,
      CANONICAL_MESSAGE_PAGE_SIZE,
    )
      .then((page) => {
        if (!page) return null;
        updateStore((current) => retainCanonicalSessionPages(
          mergeCanonicalMessagePage(current, page),
          new Set(recentPageSessionIdsRef.current),
        ));
        return page;
      })
      .catch((error) => {
        if (beforeSequenceNum === null) {
          updateStore((current) => retainCanonicalSessionPages(
            failCanonicalSessionHydration(current, normalizedSessionId),
            new Set(recentPageSessionIdsRef.current),
          ));
        }
        throw error;
      })
      .finally(() => {
        pageFlightsRef.current.delete(flightKey);
      });
    pageFlightsRef.current.set(flightKey, request);
    return request;
  }, [isNativeShell, updateStore]);

  const loadSessionHistory = useCallback(async (sessionId: string) => {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      return canonicalStateFromStore(storeRef.current);
    }
    let page = await hydrateSessionPage(
      normalizedSessionId,
      { force: true },
    );
    let pageCount = 0;
    while (
      page?.hasOlder
      && page.oldestSequenceNum !== null
      && pageCount < 10_000
    ) {
      page = await hydrateSessionPage(normalizedSessionId, {
        beforeSequenceNum: page.oldestSequenceNum,
        force: true,
      });
      pageCount += 1;
    }
    return canonicalStateFromStore(storeRef.current);
  }, [hydrateSessionPage]);

  const loadOlderSessionMessages = useCallback(async (
    sessionId: string,
  ) => {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) return;
    const currentStore = storeRef.current;
    if (!currentStore.hasOlderBySessionId[normalizedSessionId]) return;
    const currentMessages =
      currentStore.messagesBySessionId[normalizedSessionId] ?? [];
    const oldestSequenceNum = currentMessages.reduce<number | null>(
      (oldest, message) => (
        oldest === null || message.sequenceNum < oldest
          ? message.sequenceNum
          : oldest
      ),
      null,
    );
    if (oldestSequenceNum === null) {
      await hydrateSessionPage(normalizedSessionId, { force: true });
      return;
    }
    await hydrateSessionPage(normalizedSessionId, {
      beforeSequenceNum: oldestSequenceNum,
      force: true,
    });
  }, [hydrateSessionPage]);

  const refreshState = useCallback(async () => {
    if (!isNativeShell) {
      setInitialRefreshSettled(true);
      return;
    }
    const flight = refreshFlightRef.current;
    const run = requestSingleFlightRun(flight, async () => {
      try {
        const fetchedCatalog = await fetchCanonicalSessionCatalog();
        if (!fetchedCatalog) {
          throw new Error('Canonical catalog is unavailable.');
        }
        const strippedState = stripDerivedCloudUnreadCounts({
          ...fetchedCatalog,
          messages: fetchedCatalog.summaries.flatMap((summary) => (
            summary.latestMessage ? [summary.latestMessage] : []
          )),
          contextSnapshots: [],
        });
        updateStore((current) => retainCanonicalSessionPages(
          mergeCanonicalCatalog(current, {
            ...fetchedCatalog,
            sessions: strippedState?.sessions ?? fetchedCatalog.sessions,
          }),
          new Set(recentPageSessionIdsRef.current),
        ));
        setInitialRefreshError(false);
      } catch {
        setInitialRefreshError(true);
        // Canonical state is additive during migration. Existing UI remains
        // usable while a native catalog refresh is temporarily unavailable.
      } finally {
        setInitialRefreshSettled(true);
      }
    });
    await (run ?? flight.currentPromise ?? Promise.resolve());
  }, [isNativeShell, updateStore]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void refreshState();
    });
    return () => {
      cancelled = true;
    };
  }, [accountId, refreshState]);

  const resetInitialRefresh = useCallback(() => {
    setInitialRefreshSettled(false);
    setInitialRefreshError(false);
  }, []);

  return {
    store,
    state,
    setState,
    initialRefreshSettled,
    initialRefreshError,
    resetInitialRefresh,
    hydrateSessionPage,
    loadSessionHistory,
    loadOlderSessionMessages,
    refreshState,
  };
}

export function useKordiCanonicalPageHydration({
  activeConversationId,
  activeProjectSessionId,
  collaborationState,
  hydrateSessionPage,
  isNativeShell,
  store,
}: {
  activeConversationId: string;
  activeProjectSessionId: string;
  collaborationState: DesktopCollaborationState | null;
  hydrateSessionPage: (
    sessionId: string,
    options?: {
      beforeSequenceNum?: number | null;
      force?: boolean;
    },
  ) => Promise<CanonicalMessagePage | null>;
  isNativeShell: boolean;
  store: CanonicalStore;
}) {
  const activePageSessionIds = useMemo(() => {
    const catalogSessionIds = new Set(
      store.catalog?.sessions.map((session) => session.id) ?? [],
    );
    const resolve = (candidate: string | null | undefined) => (
      resolveCanonicalPageSessionId(
        candidate,
        catalogSessionIds,
        collaborationState?.conversations,
      )
    );
    return uniqueStrings([
      resolve(activeConversationId) ?? '',
      resolve(activeProjectSessionId) ?? '',
    ]);
  }, [
    activeConversationId,
    activeProjectSessionId,
    collaborationState?.conversations,
    store.catalog?.sessions,
  ]);

  useEffect(() => {
    for (const sessionId of activePageSessionIds) {
      void hydrateSessionPage(sessionId).catch(() => {});
    }
  }, [activePageSessionIds, hydrateSessionPage]);

  useEffect(() => {
    const sessionIds = (store.catalog?.sessions ?? [])
      .slice(0, 8)
      .map((session) => session.id);
    if (!isNativeShell || sessionIds.length === 0) return undefined;
    let cancelled = false;
    const prefetch = () => {
      void (async () => {
        for (const sessionId of sessionIds) {
          if (cancelled) return;
          await hydrateSessionPage(sessionId).catch(() => null);
        }
      })();
    };
    const idleWindow = window as unknown as {
      requestIdleCallback?(
        callback: () => void,
        options?: { timeout: number },
      ): number;
      cancelIdleCallback?(id: number): void;
    };
    if (typeof idleWindow.requestIdleCallback === 'function') {
      const idleId = idleWindow.requestIdleCallback(
        prefetch,
        { timeout: 1_500 },
      );
      return () => {
        cancelled = true;
        idleWindow.cancelIdleCallback?.(idleId);
      };
    }
    const timeoutId = globalThis.setTimeout(prefetch, 250);
    return () => {
      cancelled = true;
      globalThis.clearTimeout(timeoutId);
    };
  }, [
    hydrateSessionPage,
    isNativeShell,
    store.catalog?.sessions,
  ]);
}
