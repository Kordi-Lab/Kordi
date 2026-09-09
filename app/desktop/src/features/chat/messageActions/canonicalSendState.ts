import type { AppendCanonicalMessageRequest, CanonicalSessionState } from '@/kordi-app/types';

export function mergeCanonicalSessionState(current: CanonicalSessionState | null, next: CanonicalSessionState | null): CanonicalSessionState | null {
  if (!current) return next;
  if (!next) return current;
  const nextSessionIds = new Set(next.sessions.map((session) => session.id));
  const nextMessageIds = new Set(next.messages.map((message) => message.id));
  return {
    ...next,
    sessions: [
      ...next.sessions,
      ...current.sessions.filter((session) => !nextSessionIds.has(session.id)),
    ],
    messages: [
      ...next.messages,
      ...current.messages.filter((message) => !nextMessageIds.has(message.id)),
    ],
  };
}

export function appendCanonicalRequestToLocalState(
  current: CanonicalSessionState | null,
  request: AppendCanonicalMessageRequest | null,
): CanonicalSessionState | null {
  if (!current || !request) return current;
  const id = request.id?.trim() || `msg:local:${request.sessionId}:${request.sourceEventId ?? Date.now()}`;
  if (current.messages.some((message) => message.id === id)) return current;
  const createdAtMs = request.createdAtMs ?? Date.now();
  const sequenceNum = current.messages
    .filter((message) => message.sessionId === request.sessionId)
    .reduce((max, message) => Math.max(max, message.sequenceNum), 0) + 1;
  return {
    ...current,
    sessions: current.sessions.map((session) => (
      session.id === request.sessionId
        ? {
            ...session,
            updatedAtMs: Math.max(session.updatedAtMs, createdAtMs),
            lastMessageAtMs: Math.max(session.lastMessageAtMs ?? 0, createdAtMs),
          }
        : session
    )),
    messages: [
      ...current.messages,
      {
        id,
        sessionId: request.sessionId,
        senderIdentityId: request.senderIdentityId,
        senderRole: request.senderRole,
        messageKind: request.messageKind,
        contentText: request.contentText,
        content: request.content ?? {},
        parentMessageId: request.parentMessageId,
        delegatedExchangeId: request.delegatedExchangeId,
        status: request.status ?? 'sent',
        sequenceNum,
        createdAtMs,
        updatedAtMs: createdAtMs,
        contentHash: null,
        sourceTransport: request.sourceTransport,
        sourceEventId: request.sourceEventId,
      },
    ],
  };
}
