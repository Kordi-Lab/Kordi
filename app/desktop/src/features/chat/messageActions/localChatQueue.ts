import { isTerminalCloudAgentTurn } from '@/features/canonical/cloudAgentTurnLifecycle';
import type {
CanonicalSessionState,
MessageActionMetadata,
QueuedDesktopChatMessage
} from '@/kordi-app/types';
import {
type DesktopChatContextMessage
} from '@/lib/desktop';
import type {
LocalChatSendInFlight
} from "./types";

export function localChatSendIsInFlightForTarget(
  inFlight: LocalChatSendInFlight | null,
  targetSessionId: string | null,
) {
  if (!inFlight) return false;
  if (!inFlight.sessionId) return true;
  if (!targetSessionId) return false;
  return inFlight.sessionId === targetSessionId;
}

export function localChatTargetHasRunningTurn(
  desktopLiveTurn: { sessionId?: string | null; completed?: boolean } | null | undefined,
  targetSessionId: string | null,
) {
  return Boolean(targetSessionId && desktopLiveTurn?.sessionId === targetSessionId && !desktopLiveTurn.completed);
}

/**
 * A Kordi Cloud request has no native turn on the sending Mac. Its run is over once an
 * agent reply to it is complete, failed, or cancelled, or the request itself failed.
 */
export function hostedRequestIsSettled(
  state: CanonicalSessionState | null | undefined,
  requestMessageId: string,
) {
  return Boolean(state?.messages.some((message) => {
    if (message.id === requestMessageId) {
      return ['failed', 'cancelled'].includes(message.status.trim().toLowerCase());
    }
    const content = message.content && typeof message.content === 'object' && !Array.isArray(message.content)
      ? message.content as Record<string, unknown>
      : {};
    return (message.parentMessageId === requestMessageId || content.requestId === requestMessageId)
      && isTerminalCloudAgentTurn(message);
  }));
}

export type LocalChatSendDelayReason = 'session-starting' | 'same-session-running';

export function localChatSendDelayReason({
  inFlight,
  targetSessionId,
  desktopLiveTurn,
  hostedRequestRunning = false,
}: {
  inFlight: LocalChatSendInFlight | null;
  targetSessionId: string | null;
  desktopLiveTurn?: { sessionId?: string | null; completed?: boolean } | null;
  /** A Kordi Cloud request sent to the target session has not settled yet. */
  hostedRequestRunning?: boolean;
}): LocalChatSendDelayReason | null {
  if (localChatSendIsInFlightForTarget(inFlight, targetSessionId)) {
    return targetSessionId && inFlight?.sessionId === targetSessionId
      ? 'same-session-running'
      : 'session-starting';
  }
  if (localChatTargetHasRunningTurn(desktopLiveTurn, targetSessionId)) {
    return 'same-session-running';
  }
  if (targetSessionId && hostedRequestRunning) return 'same-session-running';
  return null;
}

export function queuedDesktopChatMessageFromDraft({
  sessionId,
  text,
  time,
  attachments,
  scope = 'chat',
  contextMessages,
  runtimeRoute,
  messageAction,
}: {
  sessionId: string;
  text: string;
  time: string;
  attachments: QueuedDesktopChatMessage['attachments'];
  scope?: QueuedDesktopChatMessage['scope'];
  contextMessages?: DesktopChatContextMessage[];
  runtimeRoute?: QueuedDesktopChatMessage['runtimeRoute'];
  messageAction?: MessageActionMetadata | null;
}): QueuedDesktopChatMessage {
  const timestamp = Date.now();
  const randomId = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${timestamp}-${Math.random().toString(16).slice(2)}`;
  return {
    id: `queued-local-chat:${sessionId}:${randomId}`,
    createdAtMs: timestamp,
    sessionId,
    scope,
    text,
    time,
    attachments,
    ...(contextMessages && contextMessages.length > 0 ? { contextMessages } : null),
    ...(runtimeRoute ? { runtimeRoute } : null),
    ...(messageAction ? { messageAction } : null),
  };
}
