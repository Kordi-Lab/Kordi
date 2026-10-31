import { cloudAgentTurnReplyText } from './cloudAgentReplyText';
import { agentExchangeTurnIsYielding } from './agentExchangeOutcome';
import type { CanonicalSessionState, DesktopChatTurnSnapshot } from '@/kordi-app/types';
import { isTerminalCloudAgentTurn } from '@/features/canonical/cloudAgentTurnLifecycle';
import { cloudGroupAgentRuntimeSessionId } from './cloudAgentRuntime';

/** Project owner-local progress onto the group's existing canonical row. Never publish it. */
export function projectCloudGroupLiveTurns(
  state: CanonicalSessionState | null,
  turns: Readonly<Record<string, DesktopChatTurnSnapshot>>,
  accountId?: string | null,
): CanonicalSessionState | null {
  if (!state || !accountId || Object.keys(turns).length === 0) return state;
  const ownerId = state.profile.humanIdentityId;
  if (!ownerId) return state;
  const ownedAgents = new Set(state.identities.filter(identity =>
    identity.kind === 'agent' && identity.ownerIdentityId === ownerId,
  ).map(identity => identity.id));
  const groups = new Set(state.sessions.filter(session => session.kind === 'group').map(session => session.id));
  let changed = false;
  const messages = state.messages.map(message => {
    const requestId = message.parentMessageId;
    if (!requestId || message.messageKind !== 'agent-turn'
      || !message.sourceTransport?.startsWith('cloud-group-agent')
      || !groups.has(message.sessionId) || !ownedAgents.has(message.senderIdentityId)
      || isTerminalCloudAgentTurn(message)) return message;
    const turn = turns[requestId];
    if (!turn || turn.replyToMessageId !== requestId) return message;
    const base = cloudGroupAgentRuntimeSessionId(accountId, message.sessionId)!;
    const suffix = `:request:${requestId}`;
    if (!turn.sessionId.endsWith(suffix)) return message;
    const scope = turn.sessionId.slice(0, -suffix.length);
    if (scope !== base && !scope.startsWith(`${base}:cloud_agent_`)) return message;
    changed = true;
    return withLiveTurn(message, turn);
  });
  return changed ? { ...state, messages } : state;
}

/**
 * Project this Mac's progress for the owner's own self-agent request onto its
 * canonical reply row. The published execution trace reaches the Mac only
 * after a throttled publish and a sync round trip, so a running command would
 * otherwise show as a bare waiting row. Never publish it.
 */
export function projectCloudSelfAgentLiveTurns(
  state: CanonicalSessionState | null,
  turns: Readonly<Record<string, DesktopChatTurnSnapshot>>,
): CanonicalSessionState | null {
  if (!state || Object.keys(turns).length === 0) return state;
  const ownerId = state.profile.humanIdentityId;
  if (!ownerId) return state;
  const ownedAgents = new Set(state.identities.filter(identity =>
    identity.kind === 'agent' && identity.ownerIdentityId === ownerId,
  ).map(identity => identity.id));
  let changed = false;
  const messages = state.messages.map(message => {
    // The hosted progress row is the same reply while the Mac runs the request.
    if (message.messageKind !== 'agent-turn' || !['cloud-self-agent', 'cloud-self-agent-progress'].includes(message.sourceTransport ?? '')
      || !ownedAgents.has(message.senderIdentityId) || isTerminalCloudAgentTurn(message)) return message;
    const requestId = record(message.content).cloudRequestMessageId;
    const turn = typeof requestId === 'string' ? turns[requestId] : undefined;
    if (!turn || turn.sessionId !== message.sessionId) return message;
    changed = true;
    return withLiveTurn(message, turn);
  });
  return changed ? { ...state, messages } : state;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * Native statuses the transcript reads as an unacknowledged optimistic turn
 * and hides. The runtime reports them after admission (`starting`) and after
 * the answer ended (`finalizing`), so the row keeps its processing placeholder
 * instead of disappearing for that moment.
 */
const ADMISSION_STATUSES = new Set(['starting', 'finalizing']);

export function withLiveTurn(
  message: CanonicalSessionState['messages'][number],
  turn: DesktopChatTurnSnapshot,
): CanonicalSessionState['messages'][number] {
  const { hostedRunStatus: _hostedRunStatus, synchronizationOnly: _synchronizationOnly, ...content } = record(message.content);
  const localExecutionStatus = turn.completed || !ADMISSION_STATUSES.has(turn.status) ? turn.status : undefined;
  return {
    ...message,
    contentText: turn.completed && turn.succeeded ? cloudAgentTurnReplyText(turn) : turn.assistantText,
    contentHash: null,
    status: turn.completed ? turn.status === 'cancelled' ? 'cancelled' : turn.succeeded ? 'complete' : 'failed' : 'processing',
    content: {
      ...content,
      ...(agentExchangeTurnIsYielding(turn) ? { synchronizationOnly: true } : {}),
      deliveryState: turn.completed ? turn.status === 'cancelled' ? 'cancelled' : turn.succeeded ? 'complete' : 'failed' : 'processing',
      localExecutionStatus, localExecutionMessage: turn.message,
      thinkingText: turn.thinkingText, tools: turn.tools,
      segments: turn.segments,
      startedAtMs: turn.startedAtMs, completedAtMs: turn.completedAtMs,
      ...(turn.error ? { error: turn.error } : {}),
      // A reply that ended early keeps how it ended, as its stored row will.
      ...(turn.completed && turn.ending ? { ending: turn.ending } : {}),
    },
  };
}
