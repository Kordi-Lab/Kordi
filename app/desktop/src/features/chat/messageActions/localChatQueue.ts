import type {
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

export type LocalChatSendDelayReason = 'session-starting' | 'same-session-running';

export function localChatSendDelayReason({
  inFlight,
  targetSessionId,
  desktopLiveTurn,
}: {
  inFlight: LocalChatSendInFlight | null;
  targetSessionId: string | null;
  desktopLiveTurn?: { sessionId?: string | null; completed?: boolean } | null;
}): LocalChatSendDelayReason | null {
  if (localChatSendIsInFlightForTarget(inFlight, targetSessionId)) {
    return targetSessionId && inFlight?.sessionId === targetSessionId
      ? 'same-session-running'
      : 'session-starting';
  }
  if (localChatTargetHasRunningTurn(desktopLiveTurn, targetSessionId)) {
    return 'same-session-running';
  }
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
