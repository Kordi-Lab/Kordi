import type { Dispatch, SetStateAction } from 'react';

import type { AppendCanonicalMessageRequest, CanonicalSessionMessage, CanonicalSessionState } from '@/kordi-app/types';
import { upsertCanonicalMessageFast } from '@/lib/desktop';
import { RETIRED_BY_RETRY_CONTENT_KEY } from '@/features/canonical/readModel/messageVisibility';

function contentRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isFailedUserRequest(message: CanonicalSessionMessage) {
  if (message.senderRole !== 'user') return false;
  const deliveryState = contentRecord(message.content).deliveryState;
  return message.status === 'failed' || deliveryState === 'failed';
}

function retiredContent(message: CanonicalSessionMessage, retiredAtMs: number) {
  return { ...contentRecord(message.content), [RETIRED_BY_RETRY_CONTENT_KEY]: true, retiredAtMs };
}

/**
 * The stored row that retires a failed owned-agent request once it is sent again. The row keeps its
 * failed status and gains a marker that hides it from the transcript, so the retried send is the only
 * bubble left for that request. Returns null when the message is not a failed request of this user.
 */
export function retiredFailedCanonicalRequest(
  current: CanonicalSessionState | null,
  messageId: string,
  retiredAtMs = Date.now(),
): AppendCanonicalMessageRequest | null {
  const message = current?.messages.find((candidate) => candidate.id === messageId);
  if (!message || !isFailedUserRequest(message)) return null;
  return {
    id: message.id,
    sessionId: message.sessionId,
    senderIdentityId: message.senderIdentityId,
    senderRole: message.senderRole,
    messageKind: message.messageKind,
    contentText: message.contentText,
    content: retiredContent(message, retiredAtMs),
    createdAtMs: message.createdAtMs,
    parentMessageId: message.parentMessageId,
    delegatedExchangeId: message.delegatedExchangeId,
    status: message.status,
    sourceTransport: message.sourceTransport,
    sourceEventId: message.sourceEventId,
  };
}

/** Applies a retirement built by `retiredFailedCanonicalRequest` to local canonical state. */
export function retireFailedCanonicalRequest(
  current: CanonicalSessionState | null,
  retired: AppendCanonicalMessageRequest,
): CanonicalSessionState | null {
  if (!current || !retired.id) return current;
  let changed = false;
  const messages = current.messages.map((message) => {
    if (message.id !== retired.id || message.sessionId !== retired.sessionId) return message;
    changed = true;
    return { ...message, content: retired.content, updatedAtMs: Math.max(message.updatedAtMs, Date.now()) };
  });
  return changed ? { ...current, messages } : current;
}

/** Hides the failed request locally and stores the retirement so it stays hidden after a reload. */
export function commitRetiredFailedCanonicalRequest(
  retired: AppendCanonicalMessageRequest | null,
  setCanonicalSessionState: Dispatch<SetStateAction<CanonicalSessionState | null>>,
  setError: (error: string | null) => void,
  persist: (request: AppendCanonicalMessageRequest) => Promise<unknown> = upsertCanonicalMessageFast,
) {
  if (!retired) return;
  setCanonicalSessionState((current) => retireFailedCanonicalRequest(current, retired));
  void persist(retired).catch((error: unknown) => {
    setError(error instanceof Error ? error.message : 'Unable to save message');
  });
}
