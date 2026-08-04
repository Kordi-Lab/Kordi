import type { CanonicalSessionState } from '@/kordi-app/types';

import type { PreparedCanonicalUserMessage } from './optimistic';

function contentRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function markOptimisticCanonicalMessageSent(
  current: CanonicalSessionState | null,
  sessionId: string,
  messageId: string | null | undefined,
): CanonicalSessionState | null {
  if (!current || !messageId) return current;
  const updatedAtMs = Date.now();
  return {
    ...current,
    sessions: current.sessions.map((session) => (
      session.id === sessionId
        ? { ...session, updatedAtMs: Math.max(session.updatedAtMs, updatedAtMs) }
        : session
    )),
    messages: current.messages.map((message) => {
      if (message.id !== messageId || message.sessionId !== sessionId) return message;
      return {
        ...message,
        status: 'sent',
        updatedAtMs: Math.max(message.updatedAtMs, updatedAtMs),
        content: {
          ...contentRecord(message.content),
          deliveryState: 'sent',
        },
      };
    }),
  };
}

export function sentPreparedCanonicalUserMessage(
  prepared: PreparedCanonicalUserMessage | null,
): PreparedCanonicalUserMessage | null {
  if (!prepared) return prepared;
  return {
    ...prepared,
    request: {
      ...prepared.request,
      status: 'sent',
      content: {
        ...contentRecord(prepared.request.content),
        deliveryState: 'sent',
      },
    },
  };
}
