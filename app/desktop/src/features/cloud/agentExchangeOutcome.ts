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

/** Buffer a reserved outcome while it is still arriving token by token. */
export function isAgentExchangeControlText(text: string, streaming = false): boolean {
  if (agentExchangeOutcome(text) !== null) return true;
  const compact = text.replace(/\s/g, '');
  return streaming && compact.length > 0
    && [AGENT_EXCHANGE_WAITING, AGENT_EXCHANGE_SILENT].some(value => value.startsWith(compact));
}

export function agentExchangeTurnIsYielding(turn: DesktopChatTurnSnapshot): boolean {
  if (turn.completed && !turn.succeeded) return false;
  return isAgentExchangeControlText(turn.assistantText, !turn.completed)
    || turn.tools.some(tool => tool.name === 'reach_out' && !tool.isError
      && tool.resultText?.includes(AGENT_EXCHANGE_WAITING));
}

/** A successful durable receipt owns the public question; the parent yields. */
export function agentExchangeTurnIsWaiting(turn: Pick<DesktopChatTurnSnapshot, 'succeeded' | 'assistantText' | 'tools'>): boolean {
  return turn.succeeded && (agentExchangeOutcome(turn.assistantText) === 'waiting'
    || turn.tools.some(tool => tool.name === 'reach_out' && !tool.isError
      && tool.resultText?.includes(AGENT_EXCHANGE_WAITING)));
}
