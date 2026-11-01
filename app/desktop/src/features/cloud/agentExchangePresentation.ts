import type { DesktopChatTurnSnapshot, Message } from '@/kordi-app/types';
import { isAgentExchangeControlText } from './agentExchangeOutcome';

export type AgentExchangeStatus = 'waiting' | 'processing' | 'completed' | 'failed' | 'cancelled';
export function agentExchangeStatus(value: unknown): AgentExchangeStatus | undefined {
  return ['waiting', 'processing', 'completed', 'failed', 'cancelled'].includes(String(value)) ? value as AgentExchangeStatus : undefined;
}

/** Ordered text can arrive before assistantText, and survive a live/history merge. */
export function publicAgentExchangeTurn(turn: DesktopChatTurnSnapshot): DesktopChatTurnSnapshot {
  const internal = (text: string) => isAgentExchangeControlText(text ?? '', !turn.completed);
  return {
    ...turn,
    assistantText: internal(turn.assistantText) ? '' : turn.assistantText,
    message: internal(turn.message) ? '' : turn.message,
    segments: turn.segments?.filter(segment => segment.kind !== 'text' || !internal(segment.text)),
  };
}

/** The durable question owns one progress indicator through reply and continuation. */
export function agentExchangeProgressTurn(
  state: unknown, text: string, id: string, sessionId: string,
  turn?: DesktopChatTurnSnapshot | null,
): DesktopChatTurnSnapshot | null {
  const status = agentExchangeStatus(state);
  if (status !== 'waiting' && status !== 'processing') return turn ?? null;
  return {
    sessionId, prompt: '', message: '', assistantText: text, thinkingText: '', tools: [],
    ...turn, id: `collaboration-live-turn:exchange:${id}`, status: 'processing', completed: false, succeeded: false, error: null,
    agentExchangeStatus: status,
  };
}

export function withAgentExchangeProgress(message: Message, state: unknown): Message {
  const turn = agentExchangeProgressTurn(state, message.text, `exchange-progress:${message.id}`, '', message.turn);
  return turn === message.turn || !turn ? message : { ...message, turn };
}
