import type { DesktopChatTurnSnapshot } from '@/kordi-app/types';

export function liveTurnsViewModelSignature(
  liveTurns: Record<string, DesktopChatTurnSnapshot>,
) {
  return Object.entries(liveTurns)
    .map(([sessionId, turn]) => [
      sessionId,
      turn.id,
      turn.status,
      turn.completed ? 'completed' : 'running',
      turn.succeeded ? 'succeeded' : 'pending',
      turn.error ? 'error' : 'ok',
      turn.tools.map((tool) => `${tool.id}:${tool.status}:${tool.isError ? 'error' : 'ok'}`).join(','),
    ].join('\u0000'))
    .sort()
    .join('\u0001');
}
