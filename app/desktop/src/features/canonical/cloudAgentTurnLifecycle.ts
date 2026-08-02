import type { CanonicalSessionMessage } from '@/kordi-app/types';

export const CLOUD_AGENT_TURN_LIFECYCLE_STATES = [
  'queued',
  'processing',
  'complete',
  'failed',
  'cancelled',
] as const;

export type CloudAgentTurnLifecycleState =
  typeof CLOUD_AGENT_TURN_LIFECYCLE_STATES[number];

const terminalStates = new Set<CloudAgentTurnLifecycleState>([
  'complete',
  'failed',
  'cancelled',
]);

function objectContent(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function lifecycleState(value: unknown): CloudAgentTurnLifecycleState | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return CLOUD_AGENT_TURN_LIFECYCLE_STATES.find(
    (state) => state === normalized,
  ) ?? null;
}

export function cloudAgentTurnLifecycleState(
  message: CanonicalSessionMessage,
): CloudAgentTurnLifecycleState | null {
  if (message.messageKind !== 'agent-turn') return null;
  const content = objectContent(message.content);
  const contentState = lifecycleState(content?.deliveryState);
  const statusState = lifecycleState(message.status);
  if (isTerminalCloudAgentTurnState(statusState)) return statusState;
  if (isTerminalCloudAgentTurnState(contentState)) return contentState;
  return contentState ?? statusState;
}

export function isTerminalCloudAgentTurnState(
  state: CloudAgentTurnLifecycleState | null,
): boolean {
  return state !== null && terminalStates.has(state);
}

export function canApplyCloudAgentTurnTransition(
  current: CanonicalSessionMessage,
  incoming: CanonicalSessionMessage,
): boolean {
  const currentState = cloudAgentTurnLifecycleState(current);
  const incomingState = cloudAgentTurnLifecycleState(incoming);
  if (!currentState) return true;
  if (!incomingState) return false;

  if (isTerminalCloudAgentTurnState(currentState)) {
    if (
      currentState === 'failed'
      && incomingState === 'complete'
    ) return true;
    return incomingState === currentState;
  }
  if (currentState === 'processing' && incomingState === 'queued') {
    return false;
  }
  return true;
}

export function isTerminalCloudAgentTurn(
  message: CanonicalSessionMessage,
): boolean {
  return isTerminalCloudAgentTurnState(
    cloudAgentTurnLifecycleState(message),
  );
}
