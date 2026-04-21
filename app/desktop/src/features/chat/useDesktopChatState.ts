import { useCallback, useEffect, useRef, useState } from 'react';

import type { DesktopChatMessage, DesktopChatState, DesktopChatTurnSnapshot, Message } from '@/kordi-app/types';
import { fetchDesktopChatState, fetchDesktopChatTurnState } from '@/lib/desktop';

type UseDesktopChatStateArgs = {
  isNativeShell: boolean;
  mapDesktopMessages: (sessionId: string, messages: DesktopChatMessage[]) => Message[];
};

export function useDesktopChatState({ isNativeShell, mapDesktopMessages }: UseDesktopChatStateArgs) {
  const latestDesktopSessionIdRef = useRef<string | undefined>(undefined);
  const latestDesktopRefreshRequestRef = useRef(0);

  const [desktopChatState, setDesktopChatState] = useState<DesktopChatState | null>(null);
  const [isDesktopChatLoading, setIsDesktopChatLoading] = useState(isNativeShell);
  const [desktopChatError, setDesktopChatError] = useState<string | null>(null);
  const [isDesktopChatSending, setIsDesktopChatSending] = useState(false);
  const [desktopLiveTurn, setDesktopLiveTurn] = useState<DesktopChatTurnSnapshot | null>(null);
  const [pendingUserChatMessage, setPendingUserChatMessage] = useState<{ text: string; time: string } | null>(null);
  const [cachedChatSessionMessages, setCachedChatSessionMessages] = useState<Record<string, Message[]>>({});
  const [cachedProjectSessionMessages, setCachedProjectSessionMessages] = useState<Record<string, Message[]>>({});

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
    setDesktopChatError(null);
  }, []);

  useEffect(() => {
    latestDesktopSessionIdRef.current = desktopChatState?.activeSessionId;
  }, [desktopChatState?.activeSessionId]);

  useEffect(() => {
    if (!isNativeShell) return;

    let cancelled = false;
    setIsDesktopChatLoading(true);
    fetchDesktopChatState()
      .then((state) => {
        if (cancelled || !state) return;
        setDesktopChatState(state);
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
    const assistantText = turn.assistantText.trim();
    const finishedAt = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const shouldAppendAssistantMessage =
      assistantText.length > 0 || turn.thinkingText.trim().length > 0 || turn.tools.length > 0 || Boolean(turn.error);

    setDesktopChatState((current) => {
      if (!current) return current;

      const nextSessions = current.sessions.map((session) => {
        if (session.id !== turn.sessionId) return session;
        return {
          ...session,
          updatedAtLabel: finishedAt,
          messageCount: shouldAppendAssistantMessage ? session.messageCount + 1 : session.messageCount,
        };
      });

      if (current.activeSession.id !== turn.sessionId) {
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
          messageCount: shouldAppendAssistantMessage ? current.activeSession.messageCount + 1 : current.activeSession.messageCount,
          messages: shouldAppendAssistantMessage
            ? [
                ...current.activeSession.messages,
                {
                  role: 'assistant',
                  sender: 'Kordi',
                  text: assistantText,
                  detail: undefined,
                  timeLabel: finishedAt,
                  timestampMs: Date.now(),
                  thinkingText: turn.thinkingText,
                  tools: turn.tools,
                },
              ]
            : current.activeSession.messages,
        },
      };
    });
  }, []);

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
        if (nextTurn.succeeded || nextTurn.status === 'cancelled') {
          mergeCompletedDesktopTurn(nextTurn);
          setDesktopLiveTurn(null);
        } else if (!nextTurn.succeeded) {
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
    refreshDesktopChat,
    mergeCompletedDesktopTurn,
    watchDesktopLiveTurn,
  };
}
