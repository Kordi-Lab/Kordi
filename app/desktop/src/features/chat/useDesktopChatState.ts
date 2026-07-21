import { useCallback, useEffect, useRef, useState } from 'react';

import type { DesktopChatMessage, DesktopChatState, DesktopChatTurnSnapshot, Message, QueuedDesktopChatMessage } from '@/kordi-app/types';
import { fetchDesktopChatState, fetchDesktopChatTurnState } from '@/lib/desktop';
import { formatDesktopClockTime } from '@/lib/time';

import {
  appendMappedSessionMessageToCache,
  mergeLatestDesktopChatState,
  mergeMappedSessionMessagesCache,
  pruneDesktopLiveTurnsByKnownSessions,
  pruneLocalSessionUnreadCounts,
  pruneQueuedDesktopMessagesByKnownSessions,
} from './desktopChatStateReducers';
import {
  buildCompletedDesktopAssistantMessage,
  desktopAssistantMessageMatchesTurn,
  desktopStateIncludesCompletedTurn,
  liveTurnSnapshotChanged,
  mergeDesktopTurnSnapshot,
  shouldConfirmCompletedDesktopTurnTranscript,
  shouldPollDesktopLiveTurn,
  suppressIncompleteLiveTurnEcho,
} from './desktopLiveTurns';
import { loadQueuedDesktopMessagesBySession, saveQueuedDesktopMessagesBySession } from './queuedDesktopMessages';

type UseDesktopChatStateArgs = {
  isNativeShell: boolean;
  mapDesktopMessages: (sessionId: string, messages: DesktopChatMessage[], sessionContext?: { metadata?: unknown }) => Message[];
};

function notifyBackgroundSessionCompletion(turn: DesktopChatTurnSnapshot) {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') return;
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') return;
  if (Notification.permission !== 'granted') return;

  const title = turn.succeeded
    ? 'Kordi: Background session finished'
    : turn.status === 'cancelled'
      ? 'Kordi: Background session stopped'
      : 'Kordi: Background session needs attention';

  new Notification(title, {
    body: 'Open Kordi to review the update.',
    tag: `kordi-session-${turn.sessionId}`,
  });
}

export function useDesktopChatState({ isNativeShell, mapDesktopMessages }: UseDesktopChatStateArgs) {
  const latestDesktopSessionIdRef = useRef<string | undefined>(undefined);
  const latestDesktopRefreshRequestRef = useRef(0);
  const visibleLocalSessionIdRef = useRef<string | null>(null);
  const desktopLiveTurnsBySessionRef = useRef<Record<string, DesktopChatTurnSnapshot>>({});
  const pendingLiveTurnSnapshotsRef = useRef<Record<string, DesktopChatTurnSnapshot>>({});
  const liveTurnCommitTimersRef = useRef<Record<string, number>>({});
  const watchedDesktopTurnIdsRef = useRef<Set<string>>(new Set());
  const hasLoadedInitialDesktopChatRef = useRef(false);

  const [desktopChatState, setDesktopChatState] = useState<DesktopChatState | null>(null);
  const [isDesktopChatLoading, setIsDesktopChatLoading] = useState(isNativeShell);
  const [desktopChatError, setDesktopChatError] = useState<string | null>(null);
  const [isDesktopChatSending, setIsDesktopChatSending] = useState(false);
  const [desktopLiveTurnsBySession, setDesktopLiveTurnsBySession] = useState<Record<string, DesktopChatTurnSnapshot>>({});
  const [pendingUserChatMessage, setPendingUserChatMessage] = useState<{ text: string; time: string } | null>(null);
  const [queuedDesktopMessagesBySession, setQueuedDesktopMessagesBySession] = useState<Record<string, QueuedDesktopChatMessage[]>>(() => loadQueuedDesktopMessagesBySession());
  const [cachedChatSessionMessages, setCachedChatSessionMessages] = useState<Record<string, Message[]>>({});
  const [cachedProjectSessionMessages, setCachedProjectSessionMessages] = useState<Record<string, Message[]>>({});
  const [localSessionUnreadCounts, setLocalSessionUnreadCounts] = useState<Record<string, number>>({});

  const incrementUnreadForSession = useCallback((sessionId?: string | null, count = 1) => {
    const normalizedSessionId = sessionId?.trim();
    const increment = Math.max(0, Math.floor(count));
    if (!normalizedSessionId || increment <= 0) return;
    setLocalSessionUnreadCounts((current) => ({
      ...current,
      [normalizedSessionId]: (current[normalizedSessionId] ?? 0) + increment,
    }));
  }, []);

  const clearUnreadForSession = useCallback((sessionId?: string | null) => {
    if (!sessionId) return;
    setLocalSessionUnreadCounts((current) => (
      current[sessionId]
        ? { ...current, [sessionId]: 0 }
        : current
    ));
  }, []);

  useEffect(() => {
    desktopLiveTurnsBySessionRef.current = desktopLiveTurnsBySession;
  }, [desktopLiveTurnsBySession]);

  useEffect(() => {
    if (!isNativeShell) return;
    saveQueuedDesktopMessagesBySession(queuedDesktopMessagesBySession);
  }, [isNativeShell, queuedDesktopMessagesBySession]);

  const clearScheduledLiveTurnSnapshot = useCallback((sessionId: string) => {
    const timer = liveTurnCommitTimersRef.current[sessionId];
    if (timer !== undefined) {
      window.clearTimeout(timer);
      delete liveTurnCommitTimersRef.current[sessionId];
    }
    delete pendingLiveTurnSnapshotsRef.current[sessionId];
  }, []);

  const commitLiveTurnSnapshot = useCallback((nextTurn: DesktopChatTurnSnapshot) => {
    const mergedTurn = mergeDesktopTurnSnapshot(
      desktopLiveTurnsBySessionRef.current[nextTurn.sessionId],
      nextTurn,
    );
    desktopLiveTurnsBySessionRef.current = {
      ...desktopLiveTurnsBySessionRef.current,
      [mergedTurn.sessionId]: mergedTurn,
    };
    setDesktopLiveTurnsBySession((current) => {
      const currentTurn = current[mergedTurn.sessionId];
      const nextMergedTurn = mergeDesktopTurnSnapshot(currentTurn, mergedTurn);
      return liveTurnSnapshotChanged(currentTurn, nextMergedTurn)
        ? { ...current, [nextMergedTurn.sessionId]: nextMergedTurn }
        : current;
    });
  }, []);

  const scheduleLiveTurnSnapshot = useCallback((nextTurn: DesktopChatTurnSnapshot, options: { immediate?: boolean } = {}) => {
    if (options.immediate) {
      clearScheduledLiveTurnSnapshot(nextTurn.sessionId);
      commitLiveTurnSnapshot(nextTurn);
      return;
    }

    pendingLiveTurnSnapshotsRef.current[nextTurn.sessionId] = mergeDesktopTurnSnapshot(
      pendingLiveTurnSnapshotsRef.current[nextTurn.sessionId]
        ?? desktopLiveTurnsBySessionRef.current[nextTurn.sessionId],
      nextTurn,
    );
    if (liveTurnCommitTimersRef.current[nextTurn.sessionId] !== undefined) return;

    liveTurnCommitTimersRef.current[nextTurn.sessionId] = window.setTimeout(() => {
      delete liveTurnCommitTimersRef.current[nextTurn.sessionId];
      const pendingTurn = pendingLiveTurnSnapshotsRef.current[nextTurn.sessionId];
      if (!pendingTurn) return;
      delete pendingLiveTurnSnapshotsRef.current[nextTurn.sessionId];
      commitLiveTurnSnapshot(pendingTurn);
    }, 96);
  }, [clearScheduledLiveTurnSnapshot, commitLiveTurnSnapshot]);

  const removeLiveTurnSnapshot = useCallback((sessionId: string, expectedTurnId?: string | null) => {
    clearScheduledLiveTurnSnapshot(sessionId);
    const currentRefTurn = desktopLiveTurnsBySessionRef.current[sessionId];
    if (currentRefTurn && (!expectedTurnId || currentRefTurn.id === expectedTurnId)) {
      const { [sessionId]: _removed, ...rest } = desktopLiveTurnsBySessionRef.current;
      desktopLiveTurnsBySessionRef.current = rest;
    }
    setDesktopLiveTurnsBySession((current) => {
      const currentTurn = current[sessionId];
      if (!currentTurn || (expectedTurnId && currentTurn.id !== expectedTurnId)) return current;
      const { [sessionId]: _removed, ...rest } = current;
      return rest;
    });
  }, [clearScheduledLiveTurnSnapshot]);

  useEffect(() => () => {
    for (const timer of Object.values(liveTurnCommitTimersRef.current)) {
      window.clearTimeout(timer);
    }
    liveTurnCommitTimersRef.current = {};
    pendingLiveTurnSnapshotsRef.current = {};
  }, []);

  const setVisibleLocalSessionId = useCallback((sessionId?: string | null) => {
    visibleLocalSessionIdRef.current = sessionId ?? null;
    clearUnreadForSession(sessionId);
  }, [clearUnreadForSession]);

  const refreshDesktopChat = useCallback(async (activeSessionId?: string) => {
    const targetSessionId = activeSessionId ?? latestDesktopSessionIdRef.current;
    const requestId = latestDesktopRefreshRequestRef.current + 1;
    latestDesktopRefreshRequestRef.current = requestId;

    const nextState = await fetchDesktopChatState(targetSessionId);
    if (!nextState) return;
    if (latestDesktopRefreshRequestRef.current !== requestId) return;
    if (targetSessionId && nextState.activeSessionId !== targetSessionId) return;

    latestDesktopSessionIdRef.current = nextState.activeSessionId;
    const activeLiveTurn = desktopLiveTurnsBySessionRef.current[nextState.activeSessionId];
    setDesktopChatState((current) => mergeLatestDesktopChatState(current, nextState, Boolean(activeLiveTurn && !activeLiveTurn.completed)));
    if (visibleLocalSessionIdRef.current === nextState.activeSessionId) {
      clearUnreadForSession(nextState.activeSessionId);
    }
    setDesktopChatError(null);
  }, [clearUnreadForSession]);

  const refreshCompletedDesktopTurnTranscript = useCallback(async (turn: DesktopChatTurnSnapshot) => {
    const requestId = latestDesktopRefreshRequestRef.current + 1;
    latestDesktopRefreshRequestRef.current = requestId;

    const nextState = await fetchDesktopChatState(turn.sessionId);
    if (!nextState) {
      throw new Error('Unable to load completed transcript');
    }
    if (latestDesktopRefreshRequestRef.current !== requestId) {
      throw new Error('Completed transcript refresh was superseded');
    }
    if (nextState.activeSessionId !== turn.sessionId) {
      throw new Error('Completed transcript refresh returned another session');
    }
    if (!desktopStateIncludesCompletedTurn(nextState, turn)) {
      throw new Error('Completed transcript is not available yet');
    }

    const mappedMessages = mapDesktopMessages(nextState.activeSessionId, nextState.activeSession.messages);
    latestDesktopSessionIdRef.current = nextState.activeSessionId;
    setDesktopChatState((current) => mergeLatestDesktopChatState(current, nextState, false));
    setCachedChatSessionMessages((current) => ({
      ...current,
      [nextState.activeSessionId]: mappedMessages,
    }));
    setCachedProjectSessionMessages((current) => ({
      ...current,
      [nextState.activeSessionId]: mappedMessages,
    }));
    if (visibleLocalSessionIdRef.current === nextState.activeSessionId) {
      clearUnreadForSession(nextState.activeSessionId);
    }
    setDesktopChatError(null);
  }, [clearUnreadForSession, mapDesktopMessages]);

  useEffect(() => {
    latestDesktopSessionIdRef.current = desktopChatState?.activeSessionId;
  }, [desktopChatState?.activeSessionId]);

  useEffect(() => {
    if (!desktopChatState) return;

    const knownSessionIds = new Set(desktopChatState.sessions.map((session) => session.id));
    // Keep unread counts until the user actually views the session, not merely because
    // that session is the most recently loaded desktop transcript.
    const visibleLocalSessionId = visibleLocalSessionIdRef.current;
    setLocalSessionUnreadCounts((current) => pruneLocalSessionUnreadCounts(
      current,
      knownSessionIds,
      visibleLocalSessionId,
    ));
    setDesktopLiveTurnsBySession((current) => pruneDesktopLiveTurnsByKnownSessions(
      current,
      knownSessionIds,
    ));
    setQueuedDesktopMessagesBySession((current) => pruneQueuedDesktopMessagesByKnownSessions(
      current,
      knownSessionIds,
    ));
  }, [desktopChatState]);

  useEffect(() => {
    if (!isNativeShell) return;

    let cancelled = false;
    if (!hasLoadedInitialDesktopChatRef.current) {
      setIsDesktopChatLoading(true);
    }
    fetchDesktopChatState(latestDesktopSessionIdRef.current)
      .then((state) => {
        if (cancelled || !state) return;
        const activeLiveTurn = desktopLiveTurnsBySessionRef.current[state.activeSessionId];
        setDesktopChatState((current) => mergeLatestDesktopChatState(current, state, Boolean(activeLiveTurn && !activeLiveTurn.completed)));
        if (visibleLocalSessionIdRef.current === state.activeSessionId) {
          clearUnreadForSession(state.activeSessionId);
        }
        setDesktopChatError(null);
      })
      .catch((error) => {
        if (cancelled) return;
        setDesktopChatError(error instanceof Error ? error.message : 'Unable to load chat sessions');
      })
      .finally(() => {
        if (cancelled) return;
        hasLoadedInitialDesktopChatRef.current = true;
        setIsDesktopChatLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [clearUnreadForSession, isNativeShell]);

  const activeIncompleteLiveTurn = desktopChatState?.activeSessionId
    ? desktopLiveTurnsBySession[desktopChatState.activeSessionId]
    : undefined;
  const activeSessionHasVisibleLiveTurn = Boolean(activeIncompleteLiveTurn && !activeIncompleteLiveTurn.completed);

  useEffect(() => {
    if (!isNativeShell || !desktopChatState?.activeSession) return;
    const mappedMessages = suppressIncompleteLiveTurnEcho(
      mapDesktopMessages(
        desktopChatState.activeSessionId,
        desktopChatState.activeSession.messages,
      ),
      activeIncompleteLiveTurn,
    );
    const preserveExistingMessages = activeSessionHasVisibleLiveTurn;
    setCachedChatSessionMessages((current) => mergeMappedSessionMessagesCache(
      current,
      desktopChatState.activeSessionId,
      mappedMessages,
      preserveExistingMessages,
    ));
    setCachedProjectSessionMessages((current) => mergeMappedSessionMessagesCache(
      current,
      desktopChatState.activeSessionId,
      mappedMessages,
      preserveExistingMessages,
    ));
  }, [activeIncompleteLiveTurn, activeSessionHasVisibleLiveTurn, desktopChatState?.activeSession, desktopChatState?.activeSessionId, isNativeShell, mapDesktopMessages]);

  const mergeCompletedDesktopTurn = useCallback((turn: DesktopChatTurnSnapshot) => {
    const finishedAt = formatDesktopClockTime(new Date());
    const visibleLocalSessionId = visibleLocalSessionIdRef.current;
    const shouldAppendAssistantMessage =
      turn.assistantText.trim().length > 0
      || turn.thinkingText.trim().length > 0
      || turn.tools.length > 0
      || Boolean(turn.error)
      || turn.status === 'cancelled';
    const completedMessage = shouldAppendAssistantMessage
      ? buildCompletedDesktopAssistantMessage(turn, finishedAt)
      : null;
    const isBackgroundSession = visibleLocalSessionId !== turn.sessionId
      && latestDesktopSessionIdRef.current !== turn.sessionId;

    setDesktopChatState((current) => {
      if (!current) return current;

      const activeSessionAlreadyHasCompletedMessage = Boolean(
        completedMessage
          && current.activeSession.id === turn.sessionId
          && current.activeSession.messages.some((message) => desktopAssistantMessageMatchesTurn(message, turn)),
      );
      const shouldAppendCompletedMessage = Boolean(completedMessage && !activeSessionAlreadyHasCompletedMessage);

      const updatedSessions = current.sessions.map((session) => {
        if (session.id !== turn.sessionId) return session;
        return {
          ...session,
          updatedAtLabel: finishedAt,
          messageCount: shouldAppendCompletedMessage ? session.messageCount + 1 : session.messageCount,
        };
      });
      const targetSession = updatedSessions.find((session) => session.id === turn.sessionId);
      const nextSessions = targetSession
        ? [targetSession, ...updatedSessions.filter((session) => session.id !== turn.sessionId)]
        : updatedSessions;

      if (current.activeSession.id !== turn.sessionId || !completedMessage) {
        return {
          ...current,
          sessions: nextSessions,
        };
      }

      if (activeSessionAlreadyHasCompletedMessage) {
        return {
          ...current,
          sessions: nextSessions,
          activeSession: {
            ...current.activeSession,
            updatedAtLabel: finishedAt,
          },
        };
      }

      return {
        ...current,
        sessions: nextSessions,
        activeSession: {
          ...current.activeSession,
          updatedAtLabel: finishedAt,
          messageCount: current.activeSession.messageCount + 1,
          messages: [...current.activeSession.messages, completedMessage],
        },
      };
    });

    if (!completedMessage) {
      window.setTimeout(() => removeLiveTurnSnapshot(turn.sessionId, turn.id), 180);
      if (!isBackgroundSession) {
        clearUnreadForSession(turn.sessionId);
      }
      return;
    }

    const mappedMessage = mapDesktopMessages(turn.sessionId, [completedMessage])[0];
    if (!mappedMessage) return;

    if (isBackgroundSession) {
      incrementUnreadForSession(turn.sessionId);
      notifyBackgroundSessionCompletion(turn);
    } else {
      clearUnreadForSession(turn.sessionId);
    }

    // The visible conversation can temporarily differ from
    // desktopChatState.activeSession while selection/refresh work settles. In
    // that foreground-but-inactive state, the active transcript update above
    // cannot append the completed row, and treating it as foreground used to
    // skip the cache update too. Commit the completed response/error into any
    // hydrated cache before removing the live row so one source always owns the
    // visible replacement.
    setCachedChatSessionMessages((current) => appendMappedSessionMessageToCache(
      current,
      turn.sessionId,
      mappedMessage,
    ));
    setCachedProjectSessionMessages((current) => appendMappedSessionMessageToCache(
      current,
      turn.sessionId,
      mappedMessage,
    ));
    window.setTimeout(() => removeLiveTurnSnapshot(turn.sessionId, turn.id), 180);
  }, [clearUnreadForSession, incrementUnreadForSession, mapDesktopMessages, removeLiveTurnSnapshot]);

  const watchDesktopLiveTurn = useCallback(
    async (turnOrSnapshot: string | DesktopChatTurnSnapshot) => {
      const turnId = typeof turnOrSnapshot === 'string' ? turnOrSnapshot : turnOrSnapshot.id;
      if (watchedDesktopTurnIdsRef.current.has(turnId)) return;
      watchedDesktopTurnIdsRef.current.add(turnId);
      const initialTurn = typeof turnOrSnapshot === 'string' ? null : turnOrSnapshot;

      try {
        let nextTurn = initialTurn ?? await fetchDesktopChatTurnState(
          turnId,
        );
        scheduleLiveTurnSnapshot(nextTurn, { immediate: true });

        while (!nextTurn.completed) {
          await new Promise((resolve) => window.setTimeout(resolve, 60));
          nextTurn = await fetchDesktopChatTurnState(nextTurn.id);
          if (nextTurn.completed) {
            // Do not commit completed snapshots into the live-turn store. The UI
            // intentionally hides completed live rows, so committing one creates
            // a visible gap where the streaming response disappears before the
            // historical assistant message is appended/refreshed. Keep the last
            // incomplete snapshot visible until mergeCompletedDesktopTurn swaps
            // it atomically for the completed transcript message.
            nextTurn = mergeDesktopTurnSnapshot(
              mergeDesktopTurnSnapshot(
                desktopLiveTurnsBySessionRef.current[nextTurn.sessionId],
                pendingLiveTurnSnapshotsRef.current[nextTurn.sessionId] ?? nextTurn,
              ),
              nextTurn,
            );
            clearScheduledLiveTurnSnapshot(nextTurn.sessionId);
          } else {
            scheduleLiveTurnSnapshot(nextTurn);
          }
        }

        setPendingUserChatMessage(null);

        const visibleSessionId = visibleLocalSessionIdRef.current;
        const isVisibleCompletedSession = visibleSessionId === nextTurn.sessionId
          || (!visibleSessionId && latestDesktopSessionIdRef.current === nextTurn.sessionId);

        const turnFailed = !nextTurn.succeeded && nextTurn.status !== 'cancelled';

        if (shouldConfirmCompletedDesktopTurnTranscript(nextTurn, isVisibleCompletedSession)) {
          try {
            await refreshCompletedDesktopTurnTranscript(nextTurn);
            removeLiveTurnSnapshot(nextTurn.sessionId);
            clearUnreadForSession(nextTurn.sessionId);
          } catch {
            mergeCompletedDesktopTurn(nextTurn);
          }
        } else {
          // Provider/request failures are part of the active conversation. Keep
          // them inline in the transcript instead of promoting them to the
          // sidebar-wide desktopChatError banner.
          if (turnFailed) {
            setDesktopChatError(null);
          }
          mergeCompletedDesktopTurn(nextTurn);
        }
      } catch (error) {
        if (initialTurn?.sessionId) {
          removeLiveTurnSnapshot(initialTurn.sessionId);
        }
        if (!initialTurn?.sessionId || visibleLocalSessionIdRef.current === initialTurn.sessionId) {
          setDesktopChatError(error instanceof Error ? error.message : 'Unable to stream chat turn');
        }
      } finally {
        watchedDesktopTurnIdsRef.current.delete(turnId);
      }
    },
    [clearScheduledLiveTurnSnapshot, clearUnreadForSession, mergeCompletedDesktopTurn, refreshCompletedDesktopTurnTranscript, removeLiveTurnSnapshot, scheduleLiveTurnSnapshot],
  );

  useEffect(() => {
    if (!isNativeShell) return;
    for (const turn of Object.values(desktopLiveTurnsBySession)) {
      if (!shouldPollDesktopLiveTurn(turn)) continue;
      void watchDesktopLiveTurn(turn);
    }
  }, [desktopLiveTurnsBySession, isNativeShell, watchDesktopLiveTurn]);

  return {
    desktopChatState,
    setDesktopChatState,
    isDesktopChatLoading,
    setIsDesktopChatLoading,
    desktopChatError,
    setDesktopChatError,
    isDesktopChatSending,
    setIsDesktopChatSending,
    desktopLiveTurnsBySession,
    setDesktopLiveTurnsBySession,
    pendingUserChatMessage,
    setPendingUserChatMessage,
    queuedDesktopMessagesBySession,
    setQueuedDesktopMessagesBySession,
    cachedChatSessionMessages,
    setCachedChatSessionMessages,
    cachedProjectSessionMessages,
    setCachedProjectSessionMessages,
    localSessionUnreadCounts,
    setLocalSessionUnreadCounts,
    incrementUnreadForSession,
    setVisibleLocalSessionId,
    refreshDesktopChat,
    mergeCompletedDesktopTurn,
    watchDesktopLiveTurn,
  };
}
