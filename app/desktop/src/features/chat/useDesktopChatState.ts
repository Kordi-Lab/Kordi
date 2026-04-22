import { useCallback, useEffect, useRef, useState } from 'react';

import type { DesktopChatMessage, DesktopChatState, DesktopChatTurnSnapshot, Message } from '@/kordi-app/types';
import { fetchDesktopChatState, fetchDesktopChatTurnState } from '@/lib/desktop';

type UseDesktopChatStateArgs = {
  isNativeShell: boolean;
  mapDesktopMessages: (sessionId: string, messages: DesktopChatMessage[]) => Message[];
};

function buildCompletedDesktopAssistantMessage(turn: DesktopChatTurnSnapshot, finishedAt: string): DesktopChatMessage {
  const assistantText = turn.assistantText.trim();
  const fallbackText = turn.error?.trim() ?? '';

  return {
    role: 'assistant',
    sender: 'Kordi',
    text: assistantText.length > 0 ? assistantText : fallbackText,
    detail: undefined,
    timeLabel: finishedAt,
    timestampMs: Date.now(),
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

  const [desktopChatState, setDesktopChatState] = useState<DesktopChatState | null>(null);
  const [isDesktopChatLoading, setIsDesktopChatLoading] = useState(isNativeShell);
  const [desktopChatError, setDesktopChatError] = useState<string | null>(null);
  const [isDesktopChatSending, setIsDesktopChatSending] = useState(false);
  const [desktopLiveTurnsBySession, setDesktopLiveTurnsBySession] = useState<Record<string, DesktopChatTurnSnapshot>>({});
  const [pendingUserChatMessage, setPendingUserChatMessage] = useState<{ text: string; time: string } | null>(null);
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
    const activeLiveTurn = desktopLiveTurnsBySession[nextState.activeSessionId];
    setDesktopChatState((current) => mergeLatestDesktopChatState(current, nextState, Boolean(activeLiveTurn && !activeLiveTurn.completed)));
    if (visibleLocalSessionIdRef.current === nextState.activeSessionId) {
      clearUnreadForSession(nextState.activeSessionId);
    }
    setDesktopChatError(null);
  }, [clearUnreadForSession, desktopLiveTurnsBySession]);

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
  }, [desktopChatState]);

  useEffect(() => {
    if (!isNativeShell) return;

    let cancelled = false;
    setIsDesktopChatLoading(true);
    fetchDesktopChatState()
      .then((state) => {
        if (cancelled || !state) return;
        const activeLiveTurn = desktopLiveTurnsBySession[state.activeSessionId];
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
        if (!cancelled) {
          setIsDesktopChatLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [clearUnreadForSession, desktopLiveTurnsBySession, isNativeShell]);

  useEffect(() => {
    if (!isNativeShell || !desktopChatState?.activeSession) return;
    const mappedMessages = mapDesktopMessages(
      desktopChatState.activeSessionId,
      desktopChatState.activeSession.messages,
    );
    const activeLiveTurn = desktopLiveTurnsBySession[desktopChatState.activeSessionId];
    const preserveExistingMessages = Boolean(activeLiveTurn && !activeLiveTurn.completed);
    setCachedChatSessionMessages((current) => {
      const existingMessages = current[desktopChatState.activeSessionId];
      const nextMessages = preserveExistingMessages && existingMessages && existingMessages.length > mappedMessages.length
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
      const nextMessages = preserveExistingMessages && existingMessages && existingMessages.length > mappedMessages.length
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
  }, [desktopChatState?.activeSession, desktopChatState?.activeSessionId, desktopLiveTurnsBySession, isNativeShell, mapDesktopMessages]);

  const mergeCompletedDesktopTurn = useCallback((turn: DesktopChatTurnSnapshot) => {
    const finishedAt = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const visibleLocalSessionId = visibleLocalSessionIdRef.current;
    const shouldAppendAssistantMessage =
      turn.assistantText.trim().length > 0 || turn.thinkingText.trim().length > 0 || turn.tools.length > 0 || Boolean(turn.error);
    const completedMessage = shouldAppendAssistantMessage
      ? buildCompletedDesktopAssistantMessage(turn, finishedAt)
      : null;
    const isBackgroundSession = !visibleLocalSessionId || visibleLocalSessionId !== turn.sessionId;

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
      const initialTurn = typeof turnOrSnapshot === 'string' ? null : turnOrSnapshot;

      try {
        let nextTurn = initialTurn ?? await fetchDesktopChatTurnState(
          typeof turnOrSnapshot === 'string' ? turnOrSnapshot : turnOrSnapshot.id,
        );
        setDesktopLiveTurnsBySession((current) => ({
          ...current,
          [nextTurn.sessionId]: nextTurn,
        }));

        while (!nextTurn.completed) {
          await new Promise((resolve) => window.setTimeout(resolve, 120));
          nextTurn = await fetchDesktopChatTurnState(nextTurn.id);
          setDesktopLiveTurnsBySession((current) => ({
            ...current,
            [nextTurn.sessionId]: nextTurn,
          }));
        }

        setPendingUserChatMessage(null);
        mergeCompletedDesktopTurn(nextTurn);
        if (!nextTurn.succeeded && nextTurn.status !== 'cancelled' && visibleLocalSessionIdRef.current === nextTurn.sessionId) {
          setDesktopChatError(nextTurn.error ?? nextTurn.message);
        }
      } catch (error) {
        if (initialTurn?.sessionId) {
          setDesktopLiveTurnsBySession((current) => {
            if (!current[initialTurn.sessionId]) return current;
            const { [initialTurn.sessionId]: _removed, ...rest } = current;
            return rest;
          });
        }
        if (!initialTurn?.sessionId || visibleLocalSessionIdRef.current === initialTurn.sessionId) {
          setDesktopChatError(error instanceof Error ? error.message : 'Unable to stream chat turn');
        }
      }
    },
    [mergeCompletedDesktopTurn],
  );

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
