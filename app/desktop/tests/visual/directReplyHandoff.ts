import { mapCollaborationConversationToViewModel } from '../../src/features/collaboration/transcript';
import type { DesktopChatTurnSnapshot, DesktopCollaborationConversationMessage } from '../../src/kordi-app/types';
import { conversation } from '../helpers/collaborationTranscriptFixtures';

/** Synthetic transport snapshots; no accounts or provider calls are used. */
export function directReplyHandoffMessages(phase: number, now: number, local: boolean) {
  if (!phase) return [];
  const requestId = phase === 1 ? 'client-request' : 'canonical-request';
  const request: DesktopCollaborationConversationMessage = {
    id: requestId, requestId, clientMessageId: 'client-request', direction: 'outbound',
    text: '@Synthetic Agent hello', timeLabel: '12:01', timestampMs: now,
    deliveryState: phase === 1 ? 'sending' : 'delivered',
    mentions: [{ label: 'Synthetic Agent', displayLabel: 'Synthetic Agent', targetKind: 'agent', agentId: 'agent-target', nodeId: 'node-target' }],
  };
  const completed = phase >= 8;
  const text = completed ? 'Synthetic answer is ready.' : phase >= 5 ? 'Synthetic answer' : '';
  const turn: DesktopChatTurnSnapshot | null = local && phase >= 4 ? {
    id: 'native-turn', sessionId: 'synthetic-runtime', prompt: '', message: '',
    status: completed ? 'complete' : 'processing', assistantText: text, thinkingText: '', tools: [],
    localExecutionStarted: true, completed, succeeded: completed, startedAtMs: now, error: null,
  } : null;
  const response: DesktopCollaborationConversationMessage = {
    id: phase >= 10 ? 'stored-response' : completed ? 'local-response' : 'pending-response',
    requestId, direction: local ? 'outbound-response' : 'inbound-response', sender: 'Synthetic Agent',
    text, timeLabel: '12:01', timestampMs: now + 1, deliveryState: completed ? 'complete' : 'processing', localTurn: turn,
  };
  return mapCollaborationConversationToViewModel(conversation({
    id: 'synthetic-handoff', messages: [request, ...(phase >= 3 ? [response] : [])],
    awaitingReply: !completed, updatedAtMs: now, peerDisplayName: 'Synthetic Agent',
    identity: { localAgentId: local ? 'agent-target' : 'agent-local', localAgentNodeId: local ? 'node-target' : 'node-local', localAgentName: 'Synthetic Agent' },
  }), undefined, 'Synthetic Agent', now + 2).messages;
}
