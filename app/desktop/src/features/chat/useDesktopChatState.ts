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

function notifyBackgroundSessionCompletion(sessionTitle: string, turn: DesktopChatTurnSnapshot) {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') return;
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') return;
  if (Notification.permission !== 'granted') return;

  const preview = turn.assistantText.trim() || turn.error?.trim() || 'Background session finished.';
  const body = preview.length > 140 ? `${preview.slice(0, 137)}…` : preview;
  const prefix = turn.succeeded ? 'Finished' : turn.status === 'cancelled' ? 'Stopped' : 'Needs attention';

  new Notification(`${prefix}: ${sessionTitle}`, {
    body,
    tag: `kordi-session-${turn.sessionId}`,
  });
}

export function useDesktopChatState({ isNativeShell, mapDesktopMessages }: UseDesktopChatStateArgs) {
  const latestDesktopSessionIdRef = useRef<string | undefined>(undefined);
  const latestDesktopRefreshRequestRef = useRef(0);
  const sessionTitleByIdRef = useRef<Record<string, string>>({});

  const [desktopChatState, setDesktopChatState] = useState<DesktopChatState | null>(null);
  const [isDesktopChatLoading, setIsDesktopChatLoading] = useState(isNativeShell);
  const [desktopChatError, setDesktopChatError] = useState<string | null>(null);
  const [isDesktopChatSending, setIsDesktopChatSending] = useState(false);
  const [desktopLiveTurn, setDesktopLiveTurn] = useState<DesktopChatTurnSnapshot | null>(null);
  const [pendingUserChatMessage, setPendingUserChatMessage] = useState<{ text: string; time: string } | null>(null);
  const [cachedChatSessionMessages, setCachedChatSessionMessages] = useState<Record<string, Message[]>>({});
  const [cachedProjectSessionMessages, setCachedProjectSessionMessages] = useState<Record<string, Message[]>>({});
  const [localSessionUnreadCounts, setLocalSessionUnreadCounts] = useState<Record<string, number>>({});

  const refreshDesktopChat = useCallback(async (activeSessionId?: string) => {
    const targetSessionId = activeSessionId ?? latestDesktopSessionIdRef.current;
    const requestId = latestDesktopRefreshRequestRef.current + 1;
    latestDesktopRefreshRequestRef.current = requestId;

    const nextState = await fetchDesktopChatState(targetSessionId);
    if (!nextState) return;
    if (latestDesktopRefreshRequestRef.current !== requestId) return;
    if (targetSessionId && nextState.activeSessionId !== targetSessionId) return;

    latestDesktopSessionIdRef.current = nextState.activeSessionId;
    setDesktopChatState(nextState);
    setLocalSessionUnreadCounts((current) => (
      current[nextState.activeSessionId]
        ? { ...current, [nextState.activeSessionId]: 0 }
        : current
    ));
    setDesktopChatError(null);
  }, []);

  useEffect(() => {
    latestDesktopSessionIdRef.current = desktopChatState?.activeSessionId;
  }, [desktopChatState?.activeSessionId]);

  useEffect(() => {
    if (!desktopChatState) return;

    sessionTitleByIdRef.current = Object.fromEntries(
      desktopChatState.sessions.map((session) => [session.id, session.title]),
    );

    const knownSessionIds = new Set(desktopChatState.sessions.map((session) => session.id));
    setLocalSessionUnreadCounts((current) => {
      let changed = false;
      const next: Record<string, number> = {};

      for (const [sessionId, unreadCount] of Object.entries(current)) {
        if (!knownSessionIds.has(sessionId) || unreadCount <= 0 || sessionId === desktopChatState.activeSessionId) {
          if (unreadCount > 0) {
            changed = true;
          }
          continue;
        }
        next[sessionId] = unreadCount;
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
        setDesktopChatState(state);
        setLocalSessionUnreadCounts((current) => (
          current[state.activeSessionId]
            ? { ...current, [state.activeSessionId]: 0 }
            : current
        ));
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
  }, [isNativeShell]);

  useEffect(() => {
    if (!isNativeShell || !desktopChatState?.activeSession) return;
    const mappedMessages = mapDesktopMessages(
      desktopChatState.activeSessionId,
      desktopChatState.activeSession.messages,
    );
    setCachedChatSessionMessages((current) => ({
      ...current,
      [desktopChatState.activeSessionId]: mappedMessages,
    }));
    setCachedProjectSessionMessages((current) => ({
      ...current,
      [desktopChatState.activeSessionId]: mappedMessages,
    }));
  }, [desktopChatState?.activeSession, desktopChatState?.activeSessionId, isNativeShell, mapDesktopMessages]);

  const mergeCompletedDesktopTurn = useCallback((turn: DesktopChatTurnSnapshot) => {
    const finishedAt = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const shouldAppendAssistantMessage =
      turn.assistantText.trim().length > 0 || turn.thinkingText.trim().length > 0 || turn.tools.length > 0 || Boolean(turn.error);
    const completedMessage = shouldAppendAssistantMessage
      ? buildCompletedDesktopAssistantMessage(turn, finishedAt)
      : null;
    const isBackgroundSession = latestDesktopSessionIdRef.current !== turn.sessionId;

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

    if (!completedMessage) return;

    const mappedMessage = mapDesktopMessages(turn.sessionId, [completedMessage])[0];
    if (!mappedMessage) return;

    if (isBackgroundSession) {
      setLocalSessionUnreadCounts((current) => ({
        ...current,
        [turn.sessionId]: (current[turn.sessionId] ?? 0) + 1,
      }));
      notifyBackgroundSessionCompletion(
        sessionTitleByIdRef.current[turn.sessionId] ?? 'Kordi session',
        turn,
      );
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
  }, [mapDesktopMessages]);

  const watchDesktopLiveTurn = useCallback(
    async (turnId: string) => {
      try {
        let nextTurn = await fetchDesktopChatTurnState(turnId);
        setDesktopLiveTurn(nextTurn);

        while (!nextTurn.completed) {
          await new Promise((resolve) => window.setTimeout(resolve, 120));
          nextTurn = await fetchDesktopChatTurnState(turnId);
          setDesktopLiveTurn(nextTurn);
        }

        setPendingUserChatMessage(null);
        mergeCompletedDesktopTurn(nextTurn);
        setDesktopLiveTurn(null);
        if (!nextTurn.succeeded && nextTurn.status !== 'cancelled') {
          setDesktopChatError(nextTurn.error ?? nextTurn.message);
        }
      } catch (error) {
        setDesktopChatError(error instanceof Error ? error.message : 'Unable to stream chat turn');
      } finally {
        setIsDesktopChatSending(false);
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
    desktopLiveTurn,
    setDesktopLiveTurn,
    pendingUserChatMessage,
    setPendingUserChatMessage,
    cachedChatSessionMessages,
    setCachedChatSessionMessages,
    cachedProjectSessionMessages,
    setCachedProjectSessionMessages,
    localSessionUnreadCounts,
    setLocalSessionUnreadCounts,
    refreshDesktopChat,
    mergeCompletedDesktopTurn,
    watchDesktopLiveTurn,
  };
}
