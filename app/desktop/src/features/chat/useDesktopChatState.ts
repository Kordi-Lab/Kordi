import { useCallback, useEffect, useRef, useState } from 'react';

import type { DesktopChatState, DesktopChatTurnSnapshot, QueuedDesktopChatMessage } from '@/kordi-app/types';
import {
  fetchDesktopChatActiveTurns,
  fetchDesktopChatState,
  fetchDesktopChatTurnState,
} from '@/lib/desktop';
import { formatDesktopClockTime } from '@/lib/time';

import { mergeLatestDesktopChatState, pruneDesktopLiveTurnsByKnownSessions, pruneLocalSessionUnreadCounts, pruneQueuedDesktopMessagesByKnownSessions } from './desktopChatStateReducers';
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
import { createDesktopTurnRenderAliasRegistry } from './desktopTurnRenderAliasRegistry';
import type { UseDesktopChatStateArgs } from './desktopChatState.types';
import { loadQueuedDesktopMessagesBySession, saveQueuedDesktopMessagesBySession } from './queuedDesktopMessages';
import { useDesktopSessionTranscriptCache } from './useDesktopSessionTranscriptCache';

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

export function useDesktopChatState({ isNativeShell, mapDesktopMessages, refreshCanonicalSession }: UseDesktopChatStateArgs) {
  const latestDesktopSessionIdRef = useRef<string | undefined>(undefined);
  const latestDesktopRefreshRequestRef = useRef(0);
  const visibleLocalSessionIdRef = useRef<string | null>(null);
  const desktopLiveTurnsBySessionRef = useRef<Record<string, DesktopChatTurnSnapshot>>({});
  const pendingLiveTurnSnapshotsRef = useRef<Record<string, DesktopChatTurnSnapshot>>({});
  const liveTurnCommitTimersRef = useRef<Record<string, number>>({});
  const watchedDesktopTurnIdsRef = useRef<Set<string>>(new Set());
  const discoveredDesktopTurnIdsRef = useRef<Set<string>>(new Set());
  const hasLoadedInitialDesktopChatRef = useRef(false);
  const [desktopChatState, setDesktopChatState] = useState<DesktopChatState | null>(null);
  const [isDesktopChatLoading, setIsDesktopChatLoading] = useState(isNativeShell);
  const [desktopChatError, setDesktopChatError] = useState<string | null>(null);
  const [isDesktopChatSending, setIsDesktopChatSending] = useState(false);
  const [desktopLiveTurnsBySession, setDesktopLiveTurnsBySession] = useState<Record<string, DesktopChatTurnSnapshot>>({});
  const [pendingUserChatMessage, setPendingUserChatMessage] = useState<{ text: string; time: string } | null>(null);
  const [queuedDesktopMessagesBySession, setQueuedDesktopMessagesBySession] = useState<Record<string, QueuedDesktopChatMessage[]>>(() => loadQueuedDesktopMessagesBySession());
  const [localSessionUnreadCounts, setLocalSessionUnreadCounts] = useState<Record<string, number>>({});
  const [desktopTurnRenderAliases] = useState(createDesktopTurnRenderAliasRegistry);
  const {
    cachedChatSessionMessages, cachedProjectSessionMessages,
    cachedDesktopSessionSourceMessages, hydratedDesktopSessionIds,
    mergeSessionTranscript,
    replaceSessionTranscript,
    appendSessionSourceMessage,
    pruneKnownSessions,
    isDesktopSessionTranscriptCached,
    preloadDesktopSessionTranscript,
  } = useDesktopSessionTranscriptCache({
    isNativeShell,
    mapDesktopMessages,
    liveTurnsBySessionRef: desktopLiveTurnsBySessionRef,
  });

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
    const nextState = desktopTurnRenderAliases.reconcile(await fetchDesktopChatState(targetSessionId));
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
  }, [clearUnreadForSession, desktopTurnRenderAliases]);

  const refreshCompletedDesktopTurnTranscript = useCallback(async (turn: DesktopChatTurnSnapshot) => {
    const requestId = latestDesktopRefreshRequestRef.current + 1;
    latestDesktopRefreshRequestRef.current = requestId;
    const nextState = desktopTurnRenderAliases.reconcile(await fetchDesktopChatState(turn.sessionId));
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
    latestDesktopSessionIdRef.current = nextState.activeSessionId;
    setDesktopChatState((current) => mergeLatestDesktopChatState(current, nextState, false));
    replaceSessionTranscript(nextState.activeSessionId, nextState.activeSession.messages);
    if (visibleLocalSessionIdRef.current === nextState.activeSessionId) {
      clearUnreadForSession(nextState.activeSessionId);
    }
    setDesktopChatError(null);
  }, [clearUnreadForSession, desktopTurnRenderAliases, replaceSessionTranscript]);

  useEffect(() => {
    latestDesktopSessionIdRef.current = desktopChatState?.activeSessionId;
  }, [desktopChatState?.activeSessionId]);

  useEffect(() => {
    if (!desktopChatState) return;

    const knownSessionIds = new Set([
      desktopChatState.activeSessionId,
      ...desktopChatState.sessions.map((session) => session.id),
      ...desktopChatState.projects.flatMap((project) => project.sessions.map((session) => session.id)),
    ]);
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
    pruneKnownSessions(knownSessionIds);
  }, [desktopChatState, pruneKnownSessions]);

  useEffect(() => {
    if (!isNativeShell) return;

    let cancelled = false;
    if (!hasLoadedInitialDesktopChatRef.current) {
      setIsDesktopChatLoading(true);
    }
    fetchDesktopChatState(latestDesktopSessionIdRef.current)
      .then((fetchedState) => {
        if (cancelled || !fetchedState) return;
        const state = desktopTurnRenderAliases.reconcile(fetchedState)!;
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
  }, [clearUnreadForSession, desktopTurnRenderAliases, isNativeShell]);

  const activeIncompleteLiveTurn = desktopChatState?.activeSessionId
    ? desktopLiveTurnsBySession[desktopChatState.activeSessionId]
    : undefined;
  const activeSessionHasVisibleLiveTurn = Boolean(activeIncompleteLiveTurn && !activeIncompleteLiveTurn.completed);

  useEffect(() => {
    if (!isNativeShell || !desktopChatState?.activeSession) return;
    const sourceMessages = desktopChatState.activeSession.messages;
    const mappedMessages = suppressIncompleteLiveTurnEcho(
      mapDesktopMessages(
        desktopChatState.activeSessionId,
        sourceMessages,
      ),
      activeIncompleteLiveTurn,
    );
    const preserveExistingMessages = activeSessionHasVisibleLiveTurn;
    mergeSessionTranscript(
      desktopChatState.activeSessionId,
      sourceMessages,
      preserveExistingMessages,
      mappedMessages,
    );
  }, [activeIncompleteLiveTurn, activeSessionHasVisibleLiveTurn, desktopChatState?.activeSession, desktopChatState?.activeSessionId, isNativeShell, mapDesktopMessages, mergeSessionTranscript]);

  const mergeCompletedDesktopTurn = useCallback((turn: DesktopChatTurnSnapshot) => {
    const finishedAtDate = new Date();
    const finishedAt = formatDesktopClockTime(finishedAtDate);
    const finishedAtMs = finishedAtDate.getTime();
    const visibleLocalSessionId = visibleLocalSessionIdRef.current;
    const shouldAppendAssistantMessage =
      turn.assistantText.trim().length > 0
      || turn.thinkingText.trim().length > 0
      || turn.tools.length > 0
      || Boolean(turn.error)
      || turn.status === 'cancelled';
    const completedMessage = shouldAppendAssistantMessage
      ? buildCompletedDesktopAssistantMessage(turn, finishedAtMs)
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
          updatedAtMs: finishedAtMs,
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
            updatedAtMs: finishedAtMs,
          },
        };
      }

      return {
        ...current,
        sessions: nextSessions,
        activeSession: {
          ...current.activeSession,
          updatedAtLabel: finishedAt,
          updatedAtMs: finishedAtMs,
          messageCount: current.activeSession.messageCount + 1,
          messages: [...current.activeSession.messages, completedMessage],
        },
      };
    });

    if (!completedMessage) {
      removeLiveTurnSnapshot(turn.sessionId, turn.id);
      if (!isBackgroundSession) {
        clearUnreadForSession(turn.sessionId);
      }
      return;
    }

    const appendedToSessionCache = appendSessionSourceMessage(turn.sessionId, completedMessage);

    if (isBackgroundSession && appendedToSessionCache) {
      incrementUnreadForSession(turn.sessionId);
      notifyBackgroundSessionCompletion(turn);
    } else if (!isBackgroundSession) {
      clearUnreadForSession(turn.sessionId);
    }

    removeLiveTurnSnapshot(turn.sessionId, turn.id);
  }, [appendSessionSourceMessage, clearUnreadForSession, incrementUnreadForSession, removeLiveTurnSnapshot]);

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
        desktopTurnRenderAliases.register(nextTurn);
        await refreshCanonicalSession?.(nextTurn.sessionId).catch(
          () => undefined,
        );

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
    [clearScheduledLiveTurnSnapshot, clearUnreadForSession, desktopTurnRenderAliases, mergeCompletedDesktopTurn, refreshCanonicalSession, refreshCompletedDesktopTurnTranscript, removeLiveTurnSnapshot, scheduleLiveTurnSnapshot],
  );

  useEffect(() => {
    if (!isNativeShell) return;
    for (const turn of Object.values(desktopLiveTurnsBySession)) {
      if (!shouldPollDesktopLiveTurn(turn)) continue;
      void watchDesktopLiveTurn(turn);
    }
  }, [desktopLiveTurnsBySession, isNativeShell, watchDesktopLiveTurn]);

  useEffect(() => {
    if (!isNativeShell) return;
    let cancelled = false;

    const discoverBackendTurns = async () => {
      const turns = await fetchDesktopChatActiveTurns().catch(() => []);
      if (cancelled) return;
      const currentIds = new Set(turns.map((turn) => turn.id));
      for (const turn of turns) {
        if (discoveredDesktopTurnIdsRef.current.has(turn.id)) continue;
        discoveredDesktopTurnIdsRef.current.add(turn.id);
        void watchDesktopLiveTurn(turn);
      }
      for (const turnId of discoveredDesktopTurnIdsRef.current) {
        if (!currentIds.has(turnId)) discoveredDesktopTurnIdsRef.current.delete(turnId);
      }
    };

    void discoverBackendTurns();
    const interval = window.setInterval(discoverBackendTurns, 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [isNativeShell, watchDesktopLiveTurn]);

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
    cachedChatSessionMessages, cachedProjectSessionMessages,
    cachedDesktopSessionSourceMessages, hydratedDesktopSessionIds,
    localSessionUnreadCounts,
    setLocalSessionUnreadCounts,
    incrementUnreadForSession,
    isDesktopSessionTranscriptCached,
    preloadDesktopSessionTranscript,
    setVisibleLocalSessionId,
    refreshDesktopChat,
    mergeCompletedDesktopTurn,
    watchDesktopLiveTurn,
  };
}
