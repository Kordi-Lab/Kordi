import type { CollaborationAgentRequestControl, DesktopChatTurnSnapshot, Message } from '@/kordi-app/types';

/** What a stop control stops: the chat's own agent turn, or an outreach request. */
export type AgentRequestStopTarget =
  | { kind: 'turn'; turnId: string }
  | { kind: 'collaboration'; turnId: string; request: CollaborationAgentRequestControl };

/** Resolves true when something was stopped; false or nothing lets the control offer Stop again. */
export type AgentRequestStopHandler = () => Promise<boolean | void> | boolean | void;

/** A side pane's session, so its Stop acts on that session instead of the main pane's. */
export type DesktopChatTurnStopTarget = {
  sessionId: string;
  liveTurn?: DesktopChatTurnSnapshot | null;
};

/** Stops the main pane's running turn, or the target session's when one is given. */
export type DesktopChatTurnStopHandler = (target?: DesktopChatTurnStopTarget) => Promise<boolean> | void;

/**
 * A side pane's Stop: acts on that pane's session and live turn, never on the
 * main pane's. Agent subsessions have no turn this Mac can stop.
 */
export function sidePaneTurnStop(
  conversation: { id: string; canonicalSessionId?: string | null; agentSubsessionId?: string | null },
  liveTurn: DesktopChatTurnSnapshot | null | undefined,
  onStopDesktopChatTurn: DesktopChatTurnStopHandler,
): (() => Promise<boolean> | void) | undefined {
  if (conversation.agentSubsessionId) return undefined;
  const sessionId = conversation.canonicalSessionId?.trim() || conversation.id;
  return () => onStopDesktopChatTurn({ sessionId, liveTurn });
}

const TERMINAL_TURN_STATUSES = new Set(['complete', 'completed', 'cancelled', 'failed']);

function messageIsViewersAgent(message: Pick<Message, 'role' | 'senderOwnerName'>) {
  return message.role === 'owned-agent' || message.senderOwnerName?.trim().toLowerCase() === 'you';
}

/**
 * A running turn the viewer may stop: a request the viewer sent, or any run of
 * the viewer's own agent, from admission until its terminal state. Finished
 * turns and other people's requests to other people's agents have none.
 */
export function agentRequestStopTarget(
  turn: DesktopChatTurnSnapshot | null | undefined,
  message: Pick<Message, 'role' | 'senderOwnerName'> = { role: 'owned-agent' },
): AgentRequestStopTarget | null {
  if (!turn || turn.completed || TERMINAL_TURN_STATUSES.has(turn.status)) return null;
  const viewersAgent = messageIsViewersAgent(message);
  // The agent's owner may stop any run of their agent, whoever asked for it.
  if (turn.sourceMessage?.senderIsSelf === false && !viewersAgent) return null;
  const request = turn.pendingCollaborationAgentRequest;
  if (request) return { kind: 'collaboration', turnId: turn.id, request };
  if (turn.id.startsWith('collaboration-live-turn:')) return null;
  return viewersAgent ? { kind: 'turn', turnId: turn.id } : null;
}

/** The newest running request the viewer sent in a chat, for the composer's stop. */
export function latestAgentRequestStopTarget(
  messages: readonly Message[],
  liveTurn?: DesktopChatTurnSnapshot | null,
): AgentRequestStopTarget | null {
  const live = agentRequestStopTarget(liveTurn);
  if (live) return live;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const target = message?.turn ? agentRequestStopTarget(message.turn, message) : null;
    if (target) return target;
  }
  return null;
}

/**
 * The composer's stop for a chat: the newest running request the viewer sent,
 * or the chat's own running turn. Null when nothing the viewer sent is running.
 */
export function composerAgentRequestStop({
  messages,
  liveTurn,
  liveTurnIsRunning = false,
  onStopActiveTurn,
  onStopCollaborationAgentRequest,
}: {
  messages: readonly Message[];
  liveTurn?: DesktopChatTurnSnapshot | null;
  liveTurnIsRunning?: boolean;
  onStopActiveTurn?: AgentRequestStopHandler;
  onStopCollaborationAgentRequest?: (request: CollaborationAgentRequestControl) => Promise<void> | void;
}): { requestKey: string; onStop: AgentRequestStopHandler } | null {
  const target = latestAgentRequestStopTarget(messages, liveTurn)
    ?? (liveTurnIsRunning ? { kind: 'turn' as const, turnId: 'active-live-turn' } : null);
  if (target?.kind === 'collaboration' && onStopCollaborationAgentRequest) {
    const { request } = target;
    return { requestKey: target.turnId, onStop: () => onStopCollaborationAgentRequest(request) };
  }
  if (target?.kind === 'turn' && onStopActiveTurn) {
    return { requestKey: target.turnId, onStop: onStopActiveTurn };
  }
  return null;
}
