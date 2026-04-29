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
    sender: 'My Kordi',
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

function longerLiveText(current: string, next: string) {
  return next.length >= current.length ? next : current;
}

function mergeDesktopTurnToolSnapshot(
  current: DesktopChatTurnSnapshot['tools'][number],
  next: DesktopChatTurnSnapshot['tools'][number],
): DesktopChatTurnSnapshot['tools'][number] {
  return {
    ...current,
    ...next,
    arguments: longerLiveText(current.arguments ?? '', next.arguments ?? ''),
    liveOutput: longerLiveText(current.liveOutput ?? '', next.liveOutput ?? ''),
    resultText: next.resultText || current.resultText,
    detail: next.detail || current.detail,
  };
}

function mergeDesktopTurnSnapshot(
  current: DesktopChatTurnSnapshot | undefined,
  next: DesktopChatTurnSnapshot,
): DesktopChatTurnSnapshot {
  if (!current || current.id !== next.id) return next;

  const currentToolsById = new Map(current.tools.map((tool) => [tool.id, tool]));
  const nextToolIds = new Set(next.tools.map((tool) => tool.id));
  const mergedTools = next.tools.map((tool) => {
    const existing = currentToolsById.get(tool.id);
    return existing ? mergeDesktopTurnToolSnapshot(existing, tool) : tool;
  });

  return {
    ...current,
    ...next,
    assistantText: longerLiveText(current.assistantText, next.assistantText),
    thinkingText: longerLiveText(current.thinkingText, next.thinkingText),
    tools: [
      ...mergedTools,
      ...current.tools.filter((tool) => !nextToolIds.has(tool.id)),
    ],
  };
}

function normalizedTranscriptText(value?: string | null) {
  return (value ?? '').trim().replace(/\s+/g, ' ');
}

function liveTurnResponseText(turn: DesktopChatTurnSnapshot) {
  return normalizedTranscriptText(turn.assistantText)
    || normalizedTranscriptText(turn.error)
    || (turn.completed ? normalizedTranscriptText(turn.message) : '');
}

function turnHasHistoricalArtifacts(turn: DesktopChatTurnSnapshot) {
  return turn.thinkingText.trim().length > 0 || turn.tools.length > 0;
}

function desktopAssistantMessageMatchesTurn(message: DesktopChatMessage, turn: DesktopChatTurnSnapshot) {
  if (message.role !== 'assistant') return false;
  const turnText = liveTurnResponseText(turn);
  if (turnText.length > 0 && normalizedTranscriptText(message.text) !== turnText) return false;
  if (turnText.length === 0 && !turnHasHistoricalArtifacts(turn)) return false;

  const turnThinking = normalizedTranscriptText(turn.thinkingText);
  if (turnThinking.length > 0 && normalizedTranscriptText(message.thinkingText) !== turnThinking) {
    return false;
  }

  if (turn.tools.length > 0 && (message.tools?.length ?? 0) < turn.tools.length) {
    return false;
  }

  return true;
}

function desktopStateIncludesCompletedTurn(state: DesktopChatState, turn: DesktopChatTurnSnapshot) {
  return state.activeSession.id === turn.sessionId
    && state.activeSession.messages.some((message) => desktopAssistantMessageMatchesTurn(message, turn));
}

function transcriptMessageMatchesIncompleteLiveTurn(message: Message, turn: DesktopChatTurnSnapshot) {
  if (message.role !== 'owned-agent') return false;
  const turnText = liveTurnResponseText(turn);
  if (turnText.length > 0 && normalizedTranscriptText(message.text) === turnText) return true;

  const turnThinking = normalizedTranscriptText(turn.thinkingText);
  if (turnThinking.length > 0 && normalizedTranscriptText(message.turn?.thinkingText) === turnThinking) {
    return true;
  }

  return turn.tools.length > 0 && (message.turn?.tools.length ?? 0) >= turn.tools.length;
}

function suppressIncompleteLiveTurnEcho(messages: Message[], turn?: DesktopChatTurnSnapshot) {
  if (!turn || turn.completed) return messages;
  let echoIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (transcriptMessageMatchesIncompleteLiveTurn(messages[index], turn)) {
      echoIndex = index;
      break;
    }
  }
  if (echoIndex < 0) return messages;
  return messages.filter((_, index) => index !== echoIndex);
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
    || Boolean(left.transcriptRefreshRequired) !== Boolean(right.transcriptRefreshRequired)
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

  const removeLiveTurnSnapshot = useCallback((sessionId: string) => {
    clearScheduledLiveTurnSnapshot(sessionId);
    if (desktopLiveTurnsBySessionRef.current[sessionId]) {
      const { [sessionId]: _removed, ...rest } = desktopLiveTurnsBySessionRef.current;
      desktopLiveTurnsBySessionRef.current = rest;
    }
    setDesktopLiveTurnsBySession((current) => {
      if (!current[sessionId]) return current;
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
  }, [activeIncompleteLiveTurn, activeSessionHasVisibleLiveTurn, desktopChatState?.activeSession, desktopChatState?.activeSessionId, isNativeShell, mapDesktopMessages]);

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

    removeLiveTurnSnapshot(turn.sessionId);

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
  }, [clearUnreadForSession, mapDesktopMessages, removeLiveTurnSnapshot]);

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

        if (isVisibleCompletedSession && !turnFailed && (nextTurn.transcriptRefreshRequired || turnHasHistoricalArtifacts(nextTurn))) {
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
