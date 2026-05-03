import type { DesktopChatState, DesktopChatTurnSnapshot, Message, QueuedDesktopChatMessage } from '@/kordi-app/types';

export function mergeLatestDesktopChatState(
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

export function pruneLocalSessionUnreadCounts(
  current: Record<string, number>,
  knownSessionIds: ReadonlySet<string>,
  visibleLocalSessionId?: string | null,
) {
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
}

export function pruneDesktopLiveTurnsByKnownSessions(
  current: Record<string, DesktopChatTurnSnapshot>,
  knownSessionIds: ReadonlySet<string>,
) {
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
}

export function pruneQueuedDesktopMessagesByKnownSessions(
  current: Record<string, QueuedDesktopChatMessage[]>,
  knownSessionIds: ReadonlySet<string>,
) {
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
}

export function mergeMappedSessionMessagesCache(
  current: Record<string, Message[]>,
  sessionId: string,
  mappedMessages: Message[],
  preserveExistingMessages: boolean,
) {
  const existingMessages = current[sessionId];
  const nextMessages = preserveExistingMessages && existingMessages && existingMessages.length >= mappedMessages.length
    ? existingMessages
    : mappedMessages;

  if (existingMessages === nextMessages) {
    return current;
  }

  return {
    ...current,
    [sessionId]: nextMessages,
  };
}
