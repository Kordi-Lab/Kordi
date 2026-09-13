import type { DesktopChatTurnSnapshot } from '@/kordi-app/types';
import { agentTurnHasStarted } from './agentProcessingVisibility';

// Native start_message allocates a UUID turn ID. Cloud execution projections and
// optimistic placeholders have prefixed IDs and cannot establish local admission.
const NATIVE_TURN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function withLocalExecutionProgress(
  local: DesktopChatTurnSnapshot | null | undefined,
  presented: DesktopChatTurnSnapshot,
): DesktopChatTurnSnapshot {
  const started = local && !local.completed && (local.localExecutionStarted
    || (NATIVE_TURN_ID.test(local.id) && !local.pendingCollaborationAgentRequest && agentTurnHasStarted(local)));
  return started ? { ...presented, localExecutionStarted: true } : presented;
}
