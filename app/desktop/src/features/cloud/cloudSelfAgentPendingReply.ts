import { askAgentTrace } from '@/lib/askAgentTrace';
import { useEffect, useState } from 'react';
import type { CanonicalSessionMessage, CanonicalSessionState } from '@/kordi-app/types';
import type { DesktopChatMessageRoute } from '@/lib/desktop';
import { routeRunsOnKordiCloud } from './cloudAgentRuntimeRoute';
import { cloudSyncedLocalAgentSessionIds } from './cloudSelfAgentSessionIdentity';

/** How long a request may wait for its run before the reply says it did not start. */
export const PENDING_SELF_AGENT_START_TIMEOUT_MS = 15_000;
/** Uploading attachments delays the request, so it gets longer. */
export const PENDING_SELF_AGENT_ATTACHMENT_START_TIMEOUT_MS = 60_000;
export const PENDING_SELF_AGENT_NOT_STARTED_TEXT = 'This request did not start. Send it again.';
const PENDING_SOURCE = 'cloud-self-agent-pending';

export function pendingSelfAgentReplyId(requestMessageId: string) {
  return `msg:cloud:self:pending:${requestMessageId}`;
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
): CanonicalSessionState | null {
  if (!state) return state;
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
    // No run answered in time: say so instead of showing a run that does not exist.
    const notStarted = nowMs - request.createdAtMs > startTimeoutMs(request);
    pending.push({
      id: pendingSelfAgentReplyId(request.id),
      sessionId: request.sessionId,
      senderIdentityId: agentIdentityId,
      senderRole: 'owned-agent',
      messageKind: 'agent-turn',
      contentText: '',
      content: notStarted
        ? { requestId: request.id, replyToMessageId: request.id, deliveryState: 'failed', error: PENDING_SELF_AGENT_NOT_STARTED_TEXT }
        : { requestId: request.id, replyToMessageId: request.id, deliveryState: 'processing' },
      parentMessageId: request.id,
      delegatedExchangeId: null,
      status: notStarted ? 'failed' : 'processing',
      sequenceNum: request.sequenceNum,
      // Where the stored reply sits, so the real row takes the same place.
      createdAtMs: request.createdAtMs + 1,
      updatedAtMs: request.createdAtMs + 1,
      sourceTransport: PENDING_SOURCE,
      sourceEventId: request.id,
    });
  }
  return pending.length ? { ...state, messages: [...state.messages, ...pending] } : state;
}

/** TEMPORARY TRACE (debug/ask-agent-row-trace): canonical rows of each Ask Agent session's newest request. */
export function traceSelfAgentRequestRows(
  state: CanonicalSessionState | null,
  localTurns: Readonly<Record<string, { status: string; completed: boolean; assistantText: string; id: string }>>,
  nowMs = Date.now(),
) {
  if (!state) return;
  const sessionIds = cloudSyncedLocalAgentSessionIds(state);
  const newest = new Map<string, CanonicalSessionMessage>();
  for (const message of state.messages) {
    if (!sessionIds.has(message.sessionId) || message.senderRole !== 'user') continue;
    const current = newest.get(message.sessionId);
    if (!current || message.createdAtMs > current.createdAtMs) newest.set(message.sessionId, message);
  }
  for (const request of newest.values()) {
    if (nowMs - request.createdAtMs > 10 * 60_000) continue;
    const users = state.messages.filter((message) => message.sessionId === request.sessionId && message.senderRole === 'user'
      && message.createdAtMs >= request.createdAtMs - 60_000);
    const rows = state.messages.filter((message) => message.senderRole !== 'user' && repliesTo(message, request.id));
    const wireIds = new Set(rows.map((row) => record(row.content).cloudRequestMessageId).filter((id): id is string => typeof id === 'string'));
    askAgentTrace(`canonical:${request.sessionId}`, {
      request: { id: request.id, status: request.status, transport: request.sourceTransport, deliveryState: record(request.content).deliveryState, desktopEntryId: record(request.content).desktopEntryId },
      recentUsers: users.map((message) => ({ id: message.id, transport: message.sourceTransport, status: message.status })),
      rows: rows.map((row) => ({
        id: row.id, transport: row.sourceTransport, status: row.status, deliveryState: record(row.content).deliveryState,
        phase: record(record(row.content).execution).phase, hostedRunStatus: record(row.content).hostedRunStatus, textLen: row.contentText.length,
      })),
      localTurns: [...wireIds].map((id) => localTurns[id] ? { wire: id, id: localTurns[id].id, status: localTurns[id].status, completed: localTurns[id].completed, textLen: localTurns[id].assistantText.length } : { wire: id, none: true }),
    });
  }
}
