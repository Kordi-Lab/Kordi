import type {
  DesktopChatMessage,
  DesktopChatState,
  DesktopChatTurnSnapshot,
  Message,
  QueuedDesktopChatMessage,
} from '@/kordi-app/types';

function mergeSessionSummaries(
  current: DesktopChatState['sessions'],
  next: DesktopChatState['sessions'],
): DesktopChatState['sessions'] {
  const nextIds = new Set(next.map((session) => session.id));
  const preserved = current.filter((session) => !nextIds.has(session.id));
  return preserved.length > 0 ? [...next, ...preserved] : next;
}

function mergeProjectGroups(
  current: DesktopChatState['projects'],
  next: DesktopChatState['projects'],
): DesktopChatState['projects'] {
  const currentById = new Map(current.map((project) => [project.id, project]));
  const mergedProjects = next.map((project) => {
    const currentProject = currentById.get(project.id);
    if (!currentProject) return project;
    return {
      ...project,
      sessions: mergeSessionSummaries(currentProject.sessions, project.sessions),
    };
  });
  const nextProjectIds = new Set(next.map((project) => project.id));
  const preservedProjects = current.filter((project) => !nextProjectIds.has(project.id));
  return preservedProjects.length > 0 ? [...mergedProjects, ...preservedProjects] : mergedProjects;
}

export function mergeLatestDesktopChatState(
  current: DesktopChatState | null,
  nextState: DesktopChatState,
  preserveActiveTranscript: boolean,
) {
  if (!current) return nextState;
  if (current.activeSessionId !== nextState.activeSessionId || current.activeSession.id !== nextState.activeSession.id) {
    return nextState;
  }

  const nextStateWithStableLists: DesktopChatState = {
    ...nextState,
    sessions: mergeSessionSummaries(current.sessions, nextState.sessions),
    projects: mergeProjectGroups(current.projects, nextState.projects),
  };

  const shouldPreserveActiveTranscript = preserveActiveTranscript && (
    current.activeSession.messageCount > nextState.activeSession.messageCount
    || current.activeSession.messages.length > nextState.activeSession.messages.length
  );

  if (!shouldPreserveActiveTranscript) {
    return nextStateWithStableLists;
  }

  const nextMessageCount = Math.max(current.activeSession.messageCount, nextState.activeSession.messageCount);
  const nextUpdatedAtLabel = current.activeSession.updatedAtLabel;
  const nextUpdatedAtMs = Math.max(current.activeSession.updatedAtMs, nextState.activeSession.updatedAtMs);
  const nextSubtitle = current.activeSession.subtitle;

  return {
    ...nextStateWithStableLists,
    sessions: nextStateWithStableLists.sessions.map((session) => (
      session.id === current.activeSession.id
        ? {
            ...session,
            subtitle: nextSubtitle,
            updatedAtLabel: nextUpdatedAtLabel,
            updatedAtMs: Math.max(session.updatedAtMs, nextUpdatedAtMs),
            messageCount: Math.max(session.messageCount, nextMessageCount),
          }
        : session
    )),
    projects: nextStateWithStableLists.projects.map((project) => ({
      ...project,
      sessions: project.sessions.map((session) => (
        session.id === current.activeSession.id
          ? {
              ...session,
              subtitle: nextSubtitle,
              updatedAtLabel: nextUpdatedAtLabel,
              updatedAtMs: Math.max(session.updatedAtMs, nextUpdatedAtMs),
              messageCount: Math.max(session.messageCount, nextMessageCount),
            }
          : session
      )),
    })),
    activeSession: {
      ...nextStateWithStableLists.activeSession,
      subtitle: nextSubtitle,
      updatedAtLabel: nextUpdatedAtLabel,
      updatedAtMs: nextUpdatedAtMs,
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

export function pruneDesktopSessionCacheByKnownSessions<T>(
  current: Record<string, T[]>,
  knownSessionIds: ReadonlySet<string>,
) {
  let changed = false;
  const next: Record<string, T[]> = {};
  for (const [sessionId, values] of Object.entries(current)) {
    if (!knownSessionIds.has(sessionId)) {
      changed = true;
      continue;
    }
    next[sessionId] = values;
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

export function mergeDesktopSessionSourceMessagesCache(
  current: Record<string, DesktopChatMessage[]>,
  sessionId: string,
  sourceMessages: DesktopChatMessage[],
  preserveExistingMessages: boolean,
) {
  const existingMessages = current[sessionId];
  const nextMessages = preserveExistingMessages && existingMessages && existingMessages.length >= sourceMessages.length
    ? existingMessages
    : sourceMessages;

  if (existingMessages === nextMessages) return current;
  return {
    ...current,
    [sessionId]: nextMessages,
  };
}

function desktopSourceMessageIdentity(message: DesktopChatMessage) {
  return message.transcriptRenderId?.trim()
    || message.entryId?.trim()
    || [message.role, message.timestampMs, message.timeLabel, message.text].join('\u0000');
}

export function appendDesktopSessionSourceMessageToCache(
  current: Record<string, DesktopChatMessage[]>,
  sessionId: string,
  message: DesktopChatMessage,
) {
  const existingMessages = current[sessionId];
  if (!existingMessages) return current;
  const messageIdentity = desktopSourceMessageIdentity(message);
  if (existingMessages.some((existing) => desktopSourceMessageIdentity(existing) === messageIdentity)) {
    return current;
  }

  return {
    ...current,
    [sessionId]: [...existingMessages, message],
  };
}

export function appendMappedSessionMessageToCache(
  current: Record<string, Message[]>,
  sessionId: string,
  message: Message,
) {
  const existingMessages = current[sessionId];
  if (!existingMessages) return current;
  if (message.id && existingMessages.some((existing) => existing.id === message.id)) {
    return current;
  }

  return {
    ...current,
    [sessionId]: [...existingMessages, message],
  };
}
