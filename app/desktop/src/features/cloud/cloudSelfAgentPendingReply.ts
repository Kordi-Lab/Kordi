import { useEffect, useState } from 'react';
import type { CanonicalSessionMessage, CanonicalSessionState, DesktopChatTurnSnapshot } from '@/kordi-app/types';
import type { DesktopChatMessageRoute } from '@/lib/desktop';
import { routeRunsOnKordiCloud } from './cloudAgentRuntimeRoute';
import { cloudSyncedLocalAgentSessionIds } from './cloudSelfAgentSessionIdentity';
import { withLiveTurn } from './cloudGroupLiveProjection';
import { cloudSelfAgentRequestClientMessageId } from './cloudSelfAgentIdentity';
import { cloudSelfAgentStableResponseId } from './cloudSelfAgentResponseLifecycle';
import type { CloudMessage } from './authClient';

/** How long a request may wait for its run before the reply says it did not start. */
export const PENDING_SELF_AGENT_START_TIMEOUT_MS = 15_000;
/** Uploading attachments delays the request, so it gets longer. */
export const PENDING_SELF_AGENT_ATTACHMENT_START_TIMEOUT_MS = 60_000;
export const PENDING_SELF_AGENT_NOT_STARTED_TEXT = 'This request did not start. Send it again.';
const PENDING_SOURCE = 'cloud-self-agent-pending';

export function pendingSelfAgentReplyId(requestMessageId: string) {
  return `msg:cloud:self:pending:${requestMessageId}`;
}

/**
 * The row id of a request's pending reply. Once the request's Cloud id is
 * known, it is the id its stored reply row will have, so that row replaces
 * the pending one in place: the same transcript row, with its waiting
 * animation and stop control, carries on instead of being remounted.
 */
export function pendingSelfAgentReplyRowId(requestMessageId: string, cloudRequestMessageId?: string | null) {
  const wireId = cloudRequestMessageId?.trim();
  return wireId ? cloudSelfAgentStableResponseId(wireId) : pendingSelfAgentReplyId(requestMessageId);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function repliesTo(message: CanonicalSessionMessage, requestId: string) {
  const content = record(message.content);
  return message.parentMessageId === requestId
    || content.requestId === requestId
    || content.replyToMessageId === requestId;
}

/** A hosted Ask Agent request this Mac sent that no reply row answers yet. */
function waitingHostedRequest(message: CanonicalSessionMessage) {
  const content = record(message.content);
  return message.senderRole === 'user'
    && message.sourceTransport === 'desktop-chat-ui'
    && ['sending', 'sent'].includes(message.status)
    && content.queuedMessage !== true
    && routeRunsOnKordiCloud(content.agentRuntimeRoute as DesktopChatMessageRoute | null);
}

function startTimeoutMs(message: CanonicalSessionMessage) {
  const attachments = record(message.content).attachments;
  return Array.isArray(attachments) && attachments.length > 0
    ? PENDING_SELF_AGENT_ATTACHMENT_START_TIMEOUT_MS
    : PENDING_SELF_AGENT_START_TIMEOUT_MS;
}

/** When the newest waiting request's processing reply turns into its not-started notice. */
export function nextPendingSelfAgentDeadlineMs(state: CanonicalSessionState | null, nowMs: number): number | null {
  if (!state) return null;
  let next: number | null = null;
  for (const message of state.messages) {
    if (message.senderRole !== 'user' || !waitingHostedRequest(message)) continue;
    const deadline = message.createdAtMs + startTimeoutMs(message);
    if (deadline > nowMs && (next === null || deadline < next)) next = deadline;
  }
  return next;
}

/** The clock the pending replies read; it ticks once at the next deadline. */
export function usePendingSelfAgentReplyClock(state: CanonicalSessionState | null): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const deadline = nextPendingSelfAgentDeadlineMs(state, Date.now());
    if (deadline === null) return;
    const timer = setTimeout(() => setNowMs(Date.now()), deadline - Date.now() + 50);
    return () => clearTimeout(timer);
  }, [state, nowMs]);
  return nowMs;
}

/**
 * Shows the agent's processing row as soon as a hosted Ask Agent request is
 * sent, as a group chat does for its agent's request. The row is a read-model
 * projection, never stored or synchronized, so it cannot become history. Any
 * reply row for the request (the hosted progress, the executor's progress,
 * the final, stopped or failed reply) replaces it in the same render. When
 * no reply row appears in time, the row becomes a failed notice.
 */
export function projectPendingSelfAgentReplies(
  state: CanonicalSessionState | null,
  nowMs = Date.now(),
  /** The Mac's turns by Cloud request id, and this account's Cloud messages to find that id. */
  local: { turns?: Readonly<Record<string, DesktopChatTurnSnapshot>>; cloudMessages?: readonly CloudMessage[] } = {},
): CanonicalSessionState | null {
  if (!state) return state;
  const wireIdByClientId = new Map((local.cloudMessages ?? []).flatMap((message) => (
    message.clientMessageId ? [[message.clientMessageId, message.messageId] as const] : []
  )));
  const sessionIds = cloudSyncedLocalAgentSessionIds(state);
  if (sessionIds.size === 0) return state;
  const newestUserBySession = new Map<string, CanonicalSessionMessage>();
  for (const message of state.messages) {
    // A native transcript copy of the request is not a newer request.
    if (!sessionIds.has(message.sessionId) || message.senderRole !== 'user' || message.sourceTransport === 'desktop-chat') continue;
    const current = newestUserBySession.get(message.sessionId);
    if (!current || message.createdAtMs > current.createdAtMs) newestUserBySession.set(message.sessionId, message);
  }
  const sessionById = new Map(state.sessions.map((session) => [session.id, session]));
  const pending: CanonicalSessionMessage[] = [];
  for (const request of newestUserBySession.values()) {
    if (!waitingHostedRequest(request)) continue;
    if (state.messages.some((message) => message.senderRole !== 'user' && repliesTo(message, request.id))) continue;
    const agentIdentityId = sessionById.get(request.sessionId)?.primaryIdentityId?.trim();
    if (!agentIdentityId) continue;
    // The Mac runs it before its stored reply exists: show that turn here.
    const linkedWireId = record(request.content).desktopEntryId;
    const wireId = wireIdByClientId.get(cloudSelfAgentRequestClientMessageId(request.sessionId, request.id))
      ?? (typeof linkedWireId === 'string' && linkedWireId.trim() ? linkedWireId.trim() : undefined);
    const localTurn = wireId ? local.turns?.[wireId] : undefined;
    // No run answered in time: say so instead of showing a run that does not exist.
    const notStarted = !localTurn && nowMs - request.createdAtMs > startTimeoutMs(request);
    const row: CanonicalSessionMessage = {
      id: pendingSelfAgentReplyRowId(request.id, wireId),
      sessionId: request.sessionId,
      senderIdentityId: agentIdentityId,
      senderRole: 'owned-agent',
      messageKind: 'agent-turn',
      contentText: '',
      content: notStarted
        ? { requestId: request.id, replyToMessageId: request.id, deliveryState: 'failed', error: PENDING_SELF_AGENT_NOT_STARTED_TEXT, ...(wireId ? { cloudRequestMessageId: wireId } : {}) }
        : { requestId: request.id, replyToMessageId: request.id, deliveryState: 'processing', ...(wireId ? { cloudRequestMessageId: wireId } : {}) },
      parentMessageId: request.id,
      delegatedExchangeId: null,
      status: notStarted ? 'failed' : 'processing',
      sequenceNum: request.sequenceNum,
      // Where the stored reply sits, so the real row takes the same place.
      createdAtMs: request.createdAtMs + 1,
      updatedAtMs: request.createdAtMs + 1,
      sourceTransport: PENDING_SOURCE,
      sourceEventId: request.id,
    };
    pending.push(localTurn && localTurn.sessionId === request.sessionId ? withLiveTurn(row, localTurn) : row);
  }
  return pending.length ? { ...state, messages: [...state.messages, ...pending] } : state;
}
