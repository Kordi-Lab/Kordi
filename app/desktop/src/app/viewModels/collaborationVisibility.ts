import type { DesktopCollaborationConversation } from '@/kordi-app/types';
import { isCloudCollaborationHostId } from '@/features/cloud/cloudCollaborationState';

export function collaborationChatConversationRoutesToLocalAgentPage(
  conversation: Pick<DesktopCollaborationConversation, 'hostId' | 'outreach' | 'identity' | 'projectId'>,
) {
  if (isCloudCollaborationHostId(conversation.hostId)) return false;
  const outreach = conversation.outreach;
  if (outreach?.targetKind !== 'agent') return false;
  if (outreach.parentSessionId?.trim()) return false;
  if (conversation.projectId?.trim()) return false;
  const localAgentId = conversation.identity?.localAgentId?.trim();
  const targetAgentId = outreach.targetAgentId?.trim();
  return Boolean(localAgentId && targetAgentId && localAgentId === targetAgentId);
}

export function collaborationChatConversationIsVisible(
  conversation: Pick<DesktopCollaborationConversation, 'outreach'>,
) {
  return !conversation.outreach?.parentSessionId;
}
