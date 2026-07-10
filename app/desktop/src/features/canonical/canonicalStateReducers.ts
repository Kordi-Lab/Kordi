import type {
  CanonicalReadCursorDelta,
  CanonicalSessionMessage,
  CanonicalSessionState,
} from '@/kordi-app/types';

export function mergeCanonicalReadCursorDelta(
  state: CanonicalSessionState | null,
  delta: CanonicalReadCursorDelta | null,
): CanonicalSessionState | null {
  if (!state || !delta) return state;
  let changed = false;
  const participants = state.participants.map((participant) => {
    if (participant.sessionId !== delta.sessionId || participant.identityId !== delta.identityId) {
      return participant;
    }
    if ((participant.lastSeenAtMs ?? 0) > delta.lastSeenAtMs) return participant;
    changed = true;
    return {
      ...participant,
      lastSeenAtMs: delta.lastSeenAtMs,
      lastReadMessageId: delta.lastReadMessageId ?? null,
    };
  });
  return changed ? { ...state, participants } : state;
}

export function mergeCanonicalMessageRow(
  state: CanonicalSessionState | null,
  row: CanonicalSessionMessage | null,
): CanonicalSessionState | null {
  if (!state || !row) return state;
  const existingIndex = state.messages.findIndex((message) => message.id === row.id);
  const messages = existingIndex >= 0
    ? state.messages.map((message, index) => (index === existingIndex ? row : message))
    : [...state.messages, row];
  const sessions = state.sessions.map((session) => (
    session.id === row.sessionId
      ? {
          ...session,
          updatedAtMs: Math.max(session.updatedAtMs, row.updatedAtMs),
          lastMessageAtMs: Math.max(session.lastMessageAtMs ?? 0, row.createdAtMs),
        }
      : session
  ));
  return { ...state, sessions, messages };
}
