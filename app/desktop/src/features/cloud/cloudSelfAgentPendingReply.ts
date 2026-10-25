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
/** The server-confirmed run's progress row (`hostedSelfAgentRunProgress`). */
const HOSTED_PROGRESS_SOURCE = 'cloud-self-agent-progress';

export function pendingSelfAgentReplyId(requestMessageId: string) {
  return `msg:cloud:self:pending:${requestMessageId}`;
}

/**
 * The not-started notice is a row of its own. The transcript never reopens a
 * finished turn, so a run that starts after the notice must replace the row,
 * not reuse its id, or the notice would stay above the live reply (#2026).
 */
export function pendingSelfAgentNoticeRowId(requestMessageId: string) {
  return `${pendingSelfAgentReplyId(requestMessageId)}:not-started`;
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

/**
 * A stored reply for the request's Cloud id. The Mac publishes its processing
 * reply within moments of the request, so that reply can be stored before the
 * request is linked to its Cloud id, without a parent. It is still the
 * request's reply row; a pending row beside it showed a second processing row.
 */
function repliesToCloudRequest(message: CanonicalSessionMessage, request: CanonicalSessionMessage, wireId: string | undefined, linkedWireIds: ReadonlySet<string>, localMessageIds: ReadonlySet<string>) {
  const cloudRequestMessageId = record(message.content).cloudRequestMessageId;
  if (typeof cloudRequestMessageId !== 'string' || !cloudRequestMessageId.trim()) return false;
  if (wireId) return cloudRequestMessageId === wireId || repliesTo(message, wireId);
  // The request's Cloud id is not known here yet: an unlinked reply created
  // after it, for a Cloud request no other row claims, is this request's. Its
  // parent is none, or a Cloud id that no local row has (a queued request is
  // linked to its Cloud id later), never another local request.
  return message.sessionId === request.sessionId && message.senderRole === 'owned-agent'
    && (!message.parentMessageId || !localMessageIds.has(message.parentMessageId)) && message.createdAtMs >= request.createdAtMs
    && !linkedWireIds.has(cloudRequestMessageId);
}

const NO_WIRE_IDS: ReadonlySet<string> = new Set();

/** Cloud request ids that a stored request row already carries. */
function linkedCloudRequestIds(state: CanonicalSessionState) {
  return new Set(state.messages.flatMap((message) => {
    if (message.senderRole !== 'user') return [];
    const entryId = record(message.content).desktopEntryId;
    const ids = [typeof entryId === 'string' ? entryId : null, message.sourceTransport?.startsWith('cloud-') ? message.sourceEventId : null];
    return ids.filter((id): id is string => Boolean(id?.trim()));
  }));
}

/** A hosted Ask Agent request this Mac sent that no reply row answers yet. */
function waitingHostedRequest(message: CanonicalSessionMessage) {
  const content = record(message.content);
  return message.senderRole === 'user'
    && message.sourceTransport === 'desktop-chat-ui'
    && ['sending', 'sent'].includes(message.status)
    && (content.queuedMessage !== true || content.queueState === 'sent')
    && routeRunsOnKordiCloud(content.agentRuntimeRoute as DesktopChatMessageRoute | null);
}

function startTimeoutMs(message: CanonicalSessionMessage) {
  const attachments = record(message.content).attachments;
  return Array.isArray(attachments) && attachments.length > 0
    ? PENDING_SELF_AGENT_ATTACHMENT_START_TIMEOUT_MS
    : PENDING_SELF_AGENT_START_TIMEOUT_MS;
}

function hostedRunRequestIds(state: CanonicalSessionState) {
  return new Set(state.messages.flatMap((message) => (
    message.sourceTransport === HOSTED_PROGRESS_SOURCE && message.parentMessageId ? [message.parentMessageId] : []
  )));
}

/**
 * Progress rows whose request already has a stored reply. That reply shows the
 * run, whatever message is now the newest in the chat: a message queued while
 * the agent works must not bring the run's progress row back beside it.
 */
function answeredHostedProgressIds(state: CanonicalSessionState): Set<string> {
  const progress = state.messages.filter((message) => message.sourceTransport === HOSTED_PROGRESS_SOURCE);
  if (progress.length === 0) return new Set();
  const answeredWireIds = new Set<string>();
  const answeredRequestIds = new Set<string>();
  for (const message of state.messages) {
    if (message.senderRole !== 'owned-agent' || message.sourceTransport === HOSTED_PROGRESS_SOURCE || message.sourceTransport === PENDING_SOURCE) continue;
    const content = record(message.content);
    const wireId = typeof content.cloudRequestMessageId === 'string' ? content.cloudRequestMessageId.trim() : '';
    if (wireId) answeredWireIds.add(wireId);
    for (const id of [message.parentMessageId, content.requestId, content.replyToMessageId]) {
      if (typeof id === 'string' && id.trim()) answeredRequestIds.add(id.trim());
    }
  }
  return new Set(progress.flatMap((row) => {
    const content = record(row.content);
    const wireId = typeof content.cloudRequestMessageId === 'string' ? content.cloudRequestMessageId.trim() : '';
    const requestId = row.parentMessageId?.trim() ?? '';
    return (wireId && answeredWireIds.has(wireId)) || (requestId && answeredRequestIds.has(requestId)) ? [row.id] : [];
  }));
}

function withoutMessages(state: CanonicalSessionState, ids: ReadonlySet<string>): CanonicalSessionState {
  return ids.size ? { ...state, messages: state.messages.filter((message) => !ids.has(message.id)) } : state;
}

/** When the newest waiting request's processing reply turns into its not-started notice. */
export function nextPendingSelfAgentDeadlineMs(state: CanonicalSessionState | null, nowMs: number): number | null {
  if (!state) return null;
  let next: number | null = null;
  const started = hostedRunRequestIds(state);
  for (const message of state.messages) {
    if (message.senderRole !== 'user' || !waitingHostedRequest(message) || started.has(message.id)) continue;
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
 * stored reply row for the request (the executor's progress, the final,
 * stopped or failed reply) replaces it in the same render, under the same id.
 * The server run's own progress row is folded into it: that row only says the
 * run is queued, leased or running, which this row already shows, and as a
 * second row it took the reply's place for a moment and gave it back. When no
 * run or reply appears in time, the row becomes a failed notice.
 */
export function projectPendingSelfAgentReplies(
  state: CanonicalSessionState | null,
  nowMs = Date.now(),
  /** The Mac's turns by Cloud request id, and this account's Cloud messages to find that id. */
  local: { turns?: Readonly<Record<string, DesktopChatTurnSnapshot>>; cloudMessages?: readonly CloudMessage[] } = {},
): CanonicalSessionState | null {
  if (!state) return state;
  const folded = answeredHostedProgressIds(state);
  const wireIdByClientId = new Map((local.cloudMessages ?? []).flatMap((message) => (
    message.clientMessageId ? [[message.clientMessageId, message.messageId] as const] : []
  )));
  const sessionIds = cloudSyncedLocalAgentSessionIds(state);
  if (sessionIds.size === 0) return withoutMessages(state, folded);
  const newestUserBySession = new Map<string, CanonicalSessionMessage>();
  for (const message of state.messages) {
    // A native transcript copy of the request is not a newer request.
    if (!sessionIds.has(message.sessionId) || message.senderRole !== 'user' || message.sourceTransport === 'desktop-chat') continue;
    const current = newestUserBySession.get(message.sessionId);
    if (!current || message.createdAtMs > current.createdAtMs) newestUserBySession.set(message.sessionId, message);
  }
  const sessionById = new Map(state.sessions.map((session) => [session.id, session]));
  const pending: CanonicalSessionMessage[] = [];
  let linkedWireIds: ReadonlySet<string> | null = null;
  const localMessageIds = new Set(state.messages.map((message) => message.id));
  for (const request of newestUserBySession.values()) {
    if (!waitingHostedRequest(request)) continue;
    const linkedWireId = record(request.content).desktopEntryId;
    const wireId = wireIdByClientId.get(cloudSelfAgentRequestClientMessageId(request.sessionId, request.id))
      ?? (typeof linkedWireId === 'string' && linkedWireId.trim() ? linkedWireId.trim() : undefined);
    const claimedWireIds = wireId ? NO_WIRE_IDS : (linkedWireIds ??= linkedCloudRequestIds(state));
    const replies = state.messages.filter((message) => message.senderRole !== 'user' && (
      repliesTo(message, request.id) || repliesToCloudRequest(message, request, wireId, claimedWireIds, localMessageIds)
    ));
    const hostedRuns = replies.filter((message) => message.sourceTransport === HOSTED_PROGRESS_SOURCE);
    // The run's progress row only repeats what the reply row (stored or pending) shows.
    for (const run of hostedRuns) folded.add(run.id);
    if (replies.length > hostedRuns.length) continue;
    const agentIdentityId = sessionById.get(request.sessionId)?.primaryIdentityId?.trim();
    if (!agentIdentityId) continue;
    // The Mac runs it before its stored reply exists: show that turn here.
    const localTurn = wireId ? local.turns?.[wireId] : undefined;
    // No run answered in time: say so instead of showing a run that does not exist.
    const notStarted = !localTurn && hostedRuns.length === 0 && nowMs - request.createdAtMs > startTimeoutMs(request);
    const row: CanonicalSessionMessage = {
      id: notStarted ? pendingSelfAgentNoticeRowId(request.id) : pendingSelfAgentReplyRowId(request.id, wireId),
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
  const remaining = withoutMessages(state, folded);
  return pending.length ? { ...remaining, messages: [...remaining.messages, ...pending] } : remaining;
}
