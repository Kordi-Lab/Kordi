import type { CanonicalSessionMessage, CanonicalSessionState } from '@/kordi-app/types';
import type { DesktopChatMessageRoute } from '@/lib/desktop';
import { routeRunsOnKordiCloud } from './cloudAgentRuntimeRoute';
import { cloudSyncedLocalAgentSessionIds } from './cloudSelfAgentSessionIdentity';

/** How long after sending a request its reply waits without any reply row. */
export const PENDING_SELF_AGENT_REPLY_WINDOW_MS = 2 * 60_000;
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
function waitingHostedRequest(message: CanonicalSessionMessage, nowMs: number) {
  const content = record(message.content);
  return message.senderRole === 'user'
    && message.sourceTransport === 'desktop-chat-ui'
    && ['sending', 'sent'].includes(message.status)
    && content.queuedMessage !== true
    && routeRunsOnKordiCloud(content.agentRuntimeRoute as DesktopChatMessageRoute | null)
    && nowMs - message.createdAtMs <= PENDING_SELF_AGENT_REPLY_WINDOW_MS;
}

/**
 * Shows the agent's processing row as soon as a hosted Ask Agent request is
 * sent, as a group chat does for its agent's request. The row is a read-model
 * projection, never stored or synchronized, so it cannot become history. Any
 * reply row for the request (the hosted progress, the executor's progress,
 * the final, stopped or failed reply) replaces it in the same render.
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
    if (!waitingHostedRequest(request, nowMs)) continue;
    if (state.messages.some((message) => message.senderRole !== 'user' && repliesTo(message, request.id))) continue;
    const agentIdentityId = sessionById.get(request.sessionId)?.primaryIdentityId?.trim();
    if (!agentIdentityId) continue;
    pending.push({
      id: pendingSelfAgentReplyId(request.id),
      sessionId: request.sessionId,
      senderIdentityId: agentIdentityId,
      senderRole: 'owned-agent',
      messageKind: 'agent-turn',
      contentText: '',
      content: { requestId: request.id, replyToMessageId: request.id, deliveryState: 'processing' },
      parentMessageId: request.id,
      delegatedExchangeId: null,
      status: 'processing',
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
