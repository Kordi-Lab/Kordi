import { useCallback, useEffect, useRef, useState } from 'react';

import type { DesktopChatMessage, DesktopChatState, DesktopChatTurnSnapshot, Message, QueuedDesktopChatMessage } from '@/kordi-app/types';
import { fetchDesktopChatState, fetchDesktopChatTurnState } from '@/lib/desktop';
import { formatDesktopClockTime } from '@/lib/time';

type UseDesktopChatStateArgs = {
  isNativeShell: boolean;
  mapDesktopMessages: (sessionId: string, messages: DesktopChatMessage[]) => Message[];
};

function buildCompletedDesktopAssistantMessage(turn: DesktopChatTurnSnapshot, finishedAt: string): DesktopChatMessage {
  const assistantText = turn.assistantText.trim();
  const fallbackText = turn.error?.trim() || turn.message?.trim() || '';

  return {
    role: 'assistant',
    sender: 'Kordi',
    text: assistantText.length > 0 ? assistantText : fallbackText,
    detail: undefined,
    timeLabel: finishedAt,
    timestampMs: Date.now(),
    failed: !turn.succeeded && turn.status !== 'cancelled',
    thinkingText: turn.thinkingText,
    tools: turn.tools,
  };
}

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

function liveTurnToolKey(tool: DesktopChatTurnSnapshot['tools'][number]) {
  return [
    tool.id,
    tool.name,
    tool.status,
    tool.arguments,
    tool.liveOutput,
    tool.resultText ?? '',
    tool.detail ?? '',
    String(tool.isError),
  ].join('\u0000');
}

function liveTurnSnapshotChanged(left: DesktopChatTurnSnapshot | undefined, right: DesktopChatTurnSnapshot) {
  if (!left) return true;
  if (
    left.id !== right.id
    || left.sessionId !== right.sessionId
    || left.status !== right.status
    || left.message !== right.message
    || left.assistantText !== right.assistantText
    || left.thinkingText !== right.thinkingText
    || left.completed !== right.completed
    || left.succeeded !== right.succeeded
    || left.error !== right.error
    || left.tools.length !== right.tools.length
  ) {
    return true;
  }

  return left.tools.some((tool, index) => liveTurnToolKey(tool) !== liveTurnToolKey(right.tools[index]));
}

function mergeLatestDesktopChatState(
  current: DesktopChatState | null,
  nextState: DesktopChatState,
  preserveActiveTranscript: boolean,
) {
  if (!current) return nextState;
  if (current.activeSessionId !== nextState.activeSessionId || current.activeSession.id !== nextState.activeSession.id) {
    return nextState;
  }

  const shouldPreserveActiveTranscript = preserveActiveTranscript && (
    current.activeSession.messageCount > nextState.activeSession.messageCount
    || current.activeSession.messages.length > nextState.activeSession.messages.length
  );

  if (!shouldPreserveActiveTranscript) {
    return nextState;
  }

  const nextMessageCount = Math.max(current.activeSession.messageCount, nextState.activeSession.messageCount);
  const nextUpdatedAtLabel = current.activeSession.updatedAtLabel;
  const nextSubtitle = current.activeSession.subtitle;

  return {
    ...nextState,
    sessions: nextState.sessions.map((session) => (
      session.id === current.activeSession.id
        ? {
            ...session,
            subtitle: nextSubtitle,
            updatedAtLabel: nextUpdatedAtLabel,
            messageCount: Math.max(session.messageCount, nextMessageCount),
          }
        : session
    )),
    projects: nextState.projects.map((project) => ({
      ...project,
      sessions: project.sessions.map((session) => (
        session.id === current.activeSession.id
          ? {
              ...session,
              subtitle: nextSubtitle,
              updatedAtLabel: nextUpdatedAtLabel,
              messageCount: Math.max(session.messageCount, nextMessageCount),
            }
          : session
      )),
    })),
    activeSession: {
      ...nextState.activeSession,
      subtitle: nextSubtitle,
      updatedAtLabel: nextUpdatedAtLabel,
      messageCount: nextMessageCount,
      messages: current.activeSession.messages,
    },
  };
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
  const [queuedDesktopMessagesBySession, setQueuedDesktopMessagesBySession] = useState<Record<string, QueuedDesktopChatMessage[]>>({});
  const [cachedChatSessionMessages, setCachedChatSessionMessages] = useState<Record<string, Message[]>>({});
  const [cachedProjectSessionMessages, setCachedProjectSessionMessages] = useState<Record<string, Message[]>>({});
  const [localSessionUnreadCounts, setLocalSessionUnreadCounts] = useState<Record<string, number>>({});

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

  const clearScheduledLiveTurnSnapshot = useCallback((sessionId: string) => {
    const timer = liveTurnCommitTimersRef.current[sessionId];
    if (timer !== undefined) {
      window.clearTimeout(timer);
      delete liveTurnCommitTimersRef.current[sessionId];
    }
    delete pendingLiveTurnSnapshotsRef.current[sessionId];
  }, []);

  const commitLiveTurnSnapshot = useCallback((nextTurn: DesktopChatTurnSnapshot) => {
    setDesktopLiveTurnsBySession((current) => (
      liveTurnSnapshotChanged(current[nextTurn.sessionId], nextTurn)
        ? { ...current, [nextTurn.sessionId]: nextTurn }
        : current
    ));
  }, []);

  const scheduleLiveTurnSnapshot = useCallback((nextTurn: DesktopChatTurnSnapshot, options: { immediate?: boolean } = {}) => {
    if (options.immediate || nextTurn.completed) {
      clearScheduledLiveTurnSnapshot(nextTurn.sessionId);
      commitLiveTurnSnapshot(nextTurn);
      return;
    }

    pendingLiveTurnSnapshotsRef.current[nextTurn.sessionId] = nextTurn;
    if (liveTurnCommitTimersRef.current[nextTurn.sessionId] !== undefined) return;

    liveTurnCommitTimersRef.current[nextTurn.sessionId] = window.setTimeout(() => {
      delete liveTurnCommitTimersRef.current[nextTurn.sessionId];
      const pendingTurn = pendingLiveTurnSnapshotsRef.current[nextTurn.sessionId];
      if (!pendingTurn) return;
      delete pendingLiveTurnSnapshotsRef.current[nextTurn.sessionId];
      commitLiveTurnSnapshot(pendingTurn);
    }, 96);
  }, [clearScheduledLiveTurnSnapshot, commitLiveTurnSnapshot]);

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

  useEffect(() => {
    latestDesktopSessionIdRef.current = desktopChatState?.activeSessionId;
  }, [desktopChatState?.activeSessionId]);

  useEffect(() => {
    if (!desktopChatState) return;

    const knownSessionIds = new Set(desktopChatState.sessions.map((session) => session.id));
    // Keep unread counts until the user actually views the session, not merely because
    // that session is the most recently loaded desktop transcript.
    const visibleLocalSessionId = visibleLocalSessionIdRef.current;
    setLocalSessionUnreadCounts((current) => {
      let changed = false;
      const next: Record<string, number> = {};

      for (const [sessionId, unreadCount] of Object.entries(current)) {
        if (!knownSessionIds.has(sessionId) || unreadCount <= 0 || sessionId === visibleLocalSessionId) {
          if (unreadCount > 0) {
            changed = true;
          }
          continue;
        }
        next[sessionId] = unreadCount;
      }

      return changed ? next : current;
    });
    setDesktopLiveTurnsBySession((current) => {
      let changed = false;
      const next: Record<string, DesktopChatTurnSnapshot> = {};

      for (const [sessionId, turn] of Object.entries(current)) {
        if (!knownSessionIds.has(sessionId) || turn.completed) {
          changed = true;
          continue;
        }
        next[sessionId] = turn;
      }

      return changed ? next : current;
    });
    setQueuedDesktopMessagesBySession((current) => {
      let changed = false;
      const next: Record<string, QueuedDesktopChatMessage[]> = {};
      for (const [sessionId, messages] of Object.entries(current)) {
        if (!knownSessionIds.has(sessionId) || messages.length === 0) {
          changed = true;
          continue;
        }
        next[sessionId] = messages;
      }
      return changed ? next : current;
    });
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

  const activeSessionHasVisibleLiveTurn = Boolean(
    desktopChatState?.activeSessionId
      && desktopLiveTurnsBySession[desktopChatState.activeSessionId],
  );

  useEffect(() => {
    if (!isNativeShell || !desktopChatState?.activeSession) return;
    const mappedMessages = mapDesktopMessages(
      desktopChatState.activeSessionId,
      desktopChatState.activeSession.messages,
    );
    const preserveExistingMessages = activeSessionHasVisibleLiveTurn;
    setCachedChatSessionMessages((current) => {
      const existingMessages = current[desktopChatState.activeSessionId];
      const nextMessages = preserveExistingMessages && existingMessages && existingMessages.length >= mappedMessages.length
        ? existingMessages
        : mappedMessages;
      if (existingMessages === nextMessages) {
        return current;
      }
      return {
        ...current,
        [desktopChatState.activeSessionId]: nextMessages,
      };
    });
    setCachedProjectSessionMessages((current) => {
      const existingMessages = current[desktopChatState.activeSessionId];
      const nextMessages = preserveExistingMessages && existingMessages && existingMessages.length >= mappedMessages.length
        ? existingMessages
        : mappedMessages;
      if (existingMessages === nextMessages) {
        return current;
      }
      return {
        ...current,
        [desktopChatState.activeSessionId]: nextMessages,
      };
    });
  }, [activeSessionHasVisibleLiveTurn, desktopChatState?.activeSession, desktopChatState?.activeSessionId, isNativeShell, mapDesktopMessages]);

  const mergeCompletedDesktopTurn = useCallback((turn: DesktopChatTurnSnapshot) => {
    const finishedAt = formatDesktopClockTime(new Date());
    const visibleLocalSessionId = visibleLocalSessionIdRef.current;
    const shouldAppendAssistantMessage =
      turn.assistantText.trim().length > 0 || turn.thinkingText.trim().length > 0 || turn.tools.length > 0 || Boolean(turn.error);
    const completedMessage = shouldAppendAssistantMessage
      ? buildCompletedDesktopAssistantMessage(turn, finishedAt)
      : null;
    const isBackgroundSession = visibleLocalSessionId !== turn.sessionId
      && latestDesktopSessionIdRef.current !== turn.sessionId;

    setDesktopLiveTurnsBySession((current) => {
      if (!current[turn.sessionId]) return current;
      const { [turn.sessionId]: _removed, ...rest } = current;
      return rest;
    });

    setDesktopChatState((current) => {
      if (!current) return current;

      const updatedSessions = current.sessions.map((session) => {
        if (session.id !== turn.sessionId) return session;
        return {
          ...session,
          updatedAtLabel: finishedAt,
          messageCount: completedMessage ? session.messageCount + 1 : session.messageCount,
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
      if (!isBackgroundSession) {
        clearUnreadForSession(turn.sessionId);
      }
      return;
    }

    const mappedMessage = mapDesktopMessages(turn.sessionId, [completedMessage])[0];
    if (!mappedMessage) return;

    if (isBackgroundSession) {
      setLocalSessionUnreadCounts((current) => ({
        ...current,
        [turn.sessionId]: (current[turn.sessionId] ?? 0) + 1,
      }));
      notifyBackgroundSessionCompletion(turn);
    } else {
      clearUnreadForSession(turn.sessionId);
    }

    setCachedChatSessionMessages((current) => {
      if (!isBackgroundSession || !current[turn.sessionId]) return current;
      return {
        ...current,
        [turn.sessionId]: [...current[turn.sessionId], mappedMessage],
      };
    });
    setCachedProjectSessionMessages((current) => {
      if (!isBackgroundSession || !current[turn.sessionId]) return current;
      return {
        ...current,
        [turn.sessionId]: [...current[turn.sessionId], mappedMessage],
      };
    });
  }, [clearUnreadForSession, mapDesktopMessages]);

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
          if (nextTurn.completed && nextTurn.status === 'cancelled') {
            clearScheduledLiveTurnSnapshot(nextTurn.sessionId);
          } else {
            scheduleLiveTurnSnapshot(nextTurn, { immediate: nextTurn.completed });
          }
        }

        setPendingUserChatMessage(null);

        const visibleSessionId = visibleLocalSessionIdRef.current;
        const isVisibleCompletedSession = visibleSessionId === nextTurn.sessionId
          || (!visibleSessionId && latestDesktopSessionIdRef.current === nextTurn.sessionId);

        const turnFailed = !nextTurn.succeeded && nextTurn.status !== 'cancelled';

        if (isVisibleCompletedSession && !turnFailed) {
          // The visible transcript already has the final live-turn snapshot.
          // Merge it locally instead of refetching the whole chat state, so a
          // short response completion only swaps the live row into its final
          // message and does not invalidate the surrounding page/detail rail.
          mergeCompletedDesktopTurn(nextTurn);
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
          clearScheduledLiveTurnSnapshot(initialTurn.sessionId);
          setDesktopLiveTurnsBySession((current) => {
            if (!current[initialTurn.sessionId]) return current;
            const { [initialTurn.sessionId]: _removed, ...rest } = current;
            return rest;
          });
        }
        if (!initialTurn?.sessionId || visibleLocalSessionIdRef.current === initialTurn.sessionId) {
          setDesktopChatError(error instanceof Error ? error.message : 'Unable to stream chat turn');
        }
      } finally {
        watchedDesktopTurnIdsRef.current.delete(turnId);
      }
    },
    [clearScheduledLiveTurnSnapshot, mergeCompletedDesktopTurn, scheduleLiveTurnSnapshot],
  );

  useEffect(() => {
    if (!isNativeShell) return;
    for (const turn of Object.values(desktopLiveTurnsBySession)) {
      if (turn.completed || turn.id.startsWith('local-agent-starting:')) continue;
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
    setVisibleLocalSessionId,
    refreshDesktopChat,
    mergeCompletedDesktopTurn,
    watchDesktopLiveTurn,
  };
}
