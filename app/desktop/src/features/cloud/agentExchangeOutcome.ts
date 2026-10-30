import type { DesktopChatTurnSnapshot } from '@/kordi-app/types';

/** Reserved run outcomes, consumed by the execution protocol, never chat speech. */
export const AGENT_EXCHANGE_WAITING = '{"agentExchangeOutcome":"waiting"}';
export const AGENT_EXCHANGE_SILENT = '{"agentExchangeOutcome":"silent"}';

export function agentExchangeOutcome(text: string): 'waiting' | 'silent' | null {
  try {
    const value: unknown = JSON.parse(text.trim());
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1) return null;
    const outcome = (value as Record<string, unknown>).agentExchangeOutcome;
    return outcome === 'waiting' || outcome === 'silent' ? outcome : null;
  } catch { return null; }
}

/** A successful durable receipt owns the public question; the parent yields. */
export function agentExchangeTurnIsWaiting(turn: Pick<DesktopChatTurnSnapshot, 'succeeded' | 'assistantText' | 'tools'>): boolean {
  return turn.succeeded && (agentExchangeOutcome(turn.assistantText) === 'waiting'
    || turn.tools.some(tool => tool.name === 'reach_out' && !tool.isError
      && tool.resultText?.includes(AGENT_EXCHANGE_WAITING)));
}
