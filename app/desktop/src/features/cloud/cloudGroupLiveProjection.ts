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
    const content = message.content && typeof message.content === 'object' && !Array.isArray(message.content)
      ? message.content as Record<string, unknown> : {};
    changed = true;
    return {
      ...message,
      contentText: turn.assistantText,
      contentHash: null,
      status: turn.completed ? turn.status === 'cancelled' ? 'cancelled' : turn.succeeded ? 'complete' : 'failed' : 'processing',
      content: {
        ...content,
        deliveryState: turn.completed ? turn.status === 'cancelled' ? 'cancelled' : turn.succeeded ? 'complete' : 'failed' : 'processing',
        localExecutionStatus: turn.status, localExecutionMessage: turn.message,
        thinkingText: turn.thinkingText, tools: turn.tools,
        startedAtMs: turn.startedAtMs, completedAtMs: turn.completedAtMs,
        ...(turn.error ? { error: turn.error } : {}),
      },
    };
  });
  return changed ? { ...state, messages } : state;
}
