import type { DesktopChatTurnSnapshot } from '@/kordi-app/types';

export type LocalAgentRelayTurnResult = Pick<DesktopChatTurnSnapshot, 'assistantText' | 'error' | 'succeeded' | 'status'>;
export type LocalAgentRelayTerminalDeliveryState = 'responded' | 'cancelled' | 'processing_failed';

function turnWasCancelled(turn: Pick<LocalAgentRelayTurnResult, 'status'>) {
  return turn.status === 'cancelled' || turn.status === 'cancelling';
}

export function localAgentRelayTerminalDeliveryState(turn: LocalAgentRelayTurnResult): LocalAgentRelayTerminalDeliveryState {
  if (turnWasCancelled(turn)) return 'cancelled';
  return turn.succeeded && turn.assistantText.trim() ? 'responded' : 'processing_failed';
}

export function localAgentRelayFailureText(turn: Pick<LocalAgentRelayTurnResult, 'error' | 'status'>) {
  if (turnWasCancelled(turn)) return 'Stopped';
  return 'Processing failed';
}

export async function awaitRelayProgressBeforeTerminal(
  progressRelayPromise: Promise<void> | null,
  timeoutMs = 1_500,
) {
  if (!progressRelayPromise) return;
  await Promise.race([
    progressRelayPromise,
    new Promise<void>((resolve) => globalThis.setTimeout(resolve, timeoutMs)),
  ]);
}

export async function waitForCompletedDesktopTurn(
  fetchTurnState: (turnId: string) => Promise<DesktopChatTurnSnapshot>,
  turnId: string,
  pollIntervalMs = 60,
) {
  let turn = await fetchTurnState(turnId);
  while (!turn.completed) {
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, pollIntervalMs));
    turn = await fetchTurnState(turn.id);
  }
  return turn;
}
