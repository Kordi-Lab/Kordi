import type { DesktopChatTurnSnapshot, Message } from '@/kordi-app/types';
import { isProcessingPlaceholderText } from '@/features/collaboration/agentPlaceholderText';

export function agentTurnHasStarted(turn: DesktopChatTurnSnapshot) {
  if (turn.completed) return true;
  const text = turn.assistantText.trim();
  if (turn.thinkingText.trim() || turn.tools.length > 0 || (text && !isProcessingPlaceholderText(text))) return true;
  // A request/stop handle is not evidence that the remote agent started work.
  if (turn.localExecutionStarted) return true;
  if (turn.pendingCollaborationAgentRequest) return false;
  return ['preparing', 'streaming', 'processing', 'thinking', 'writing', 'tooling', 'running', 'retrying', 'cancelling', 'compacting', 'compacted', 'compaction_failed'].includes(turn.status);
}

export function canDisplayAgentTurn(turn: DesktopChatTurnSnapshot, messages: readonly Message[] = []) {
  if (turn.completed) return true;
  const requestId = turn.replyToMessageId ?? turn.sourceMessage?.messageId;
  const request = requestId ? messages.find((message) => (
    (message.role === 'user' || message.role === 'person')
      && [message.id, message.entryId, ...(message.replyAliasIds ?? [])].includes(requestId)
  )) : undefined;
  if (request?.statusChips?.some((status) => ['draft', 'sending', 'queued', 'pending', 'failed', 'cancelled'].includes(status.trim().toLowerCase()))) return false;
  // Keep cancellation controls available for sent outreach requests, without
  // treating those controls as a processing event.
  return agentTurnHasStarted(turn) || Boolean(turn.pendingCollaborationAgentRequest);
}

export function shouldShowAgentWaitingAnimation(turn: DesktopChatTurnSnapshot) {
  if (turn.completed || ['starting', 'queued', 'cancelled', 'failed'].includes(turn.status)) return false;
  // Match AgentSessionQueuePresentation: acknowledged requests have waiting
  // feedback before execution output. This does not change execution admission.
  return agentTurnHasStarted(turn) || Boolean(turn.pendingCollaborationAgentRequest);
}
