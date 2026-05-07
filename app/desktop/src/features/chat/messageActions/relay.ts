import type { ConversationBridgeTarget, DesktopBridgeSessionParticipant, DesktopBridgeSessionThreadMessage, DesktopBridgeState, DesktopChatToolSnapshot } from '@/kordi-app/types';
import { createDesktopBridgeOutreach } from '@/lib/desktop';

import type { AttachmentItem } from '../composerController.types';
import { bridgeAttachmentTransportFields } from './optimistic';
import type { PendingBridgeOutreach } from './types';

export function pendingOutreachFromState(
  state: DesktopBridgeState,
  parentSessionId: string,
  targetNodeId: string,
): PendingBridgeOutreach | null {
  const conversation = state.conversations.find((candidate) => (
    candidate.outreach?.parentSessionId === parentSessionId
    && candidate.outreach?.targetNodeId === targetNodeId
  ));
  if (!conversation) return null;
  return {
    conversationId: conversation.id,
    requestId: conversation.outreach?.bridgeRequestId ?? null,
    parentSessionId,
  };
}

export type RelaySharedSessionMessageOptions = {
  parentSessionKind?: string | null;
  parentGroupSpaceId?: string | null;
  parentSessionParticipants?: DesktopBridgeSessionParticipant[];
  parentSessionMessages?: DesktopBridgeSessionThreadMessage[];
  taskTools?: DesktopChatToolSnapshot[];
  attachments?: AttachmentItem[];
};

export async function relaySharedSessionMessage(
  target: ConversationBridgeTarget,
  parentSessionId: string,
  requestText: string,
  parentSessionTitle?: string | null,
  parentMessageId?: string | null,
  parentTurnId?: string | null,
  deliveryState?: string | null,
  bridgeRequestId?: string | null,
  options: RelaySharedSessionMessageOptions = {},
) {
  const taskTools = (options.taskTools ?? []).filter((tool) => tool.name.trim().toLowerCase() === 'task_operator' || tool.name.trim().toLowerCase() === 'update_plan' || tool.isError);
  const parentSessionMessages = [
    ...(options.parentSessionMessages ?? []),
    ...(taskTools.length > 0 ? [{
      role: 'assistant',
      sender: null,
      text: requestText,
      timeLabel: null,
      index: null,
      tools: taskTools,
    }] : []),
  ];

  return createDesktopBridgeOutreach({
    hostId: target.hostId,
    targetNodeId: target.nodeId,
    targetKind: 'bridge-person',
    requestText,
    targetDisplayName: target.displayName ?? target.ownerName ?? null,
    targetOwnerName: target.ownerName ?? target.displayName ?? null,
    targetRuntime: 'person',
    targetHumanId: target.humanId ?? null,
    targetAgentId: null,
    triggerText: parentTurnId ? null : requestText,
    contextText: null,
    contextPolicy: 'session-relay',
    parentSessionId,
    parentSessionTitle,
    parentSessionKind: options.parentSessionKind,
    parentGroupSpaceId: options.parentGroupSpaceId,
    parentSessionParticipants: options.parentSessionParticipants ?? [],
    parentSessionMessages,
    parentTurnId,
    parentMessageId,
    bridgeRequestId,
    deliveryState,
    projectId: null,
    projectName: null,
    ...bridgeAttachmentTransportFields(options.attachments ?? []),
  });
}
