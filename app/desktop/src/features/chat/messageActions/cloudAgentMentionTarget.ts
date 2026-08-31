import { defaultCloudAgentId } from '@/features/cloud/cloudAgentIdentity';
import { stripSelfPossessivePrefix } from '@/lib/identityLabels';
import type { SharedCloudAgentSummary } from '@/features/cloud/cloudAgents';
import type { DesktopChatState, DesktopCollaborationState } from '@/kordi-app/types';
import type { ResolvedMentionedCollaborationTarget } from './types';
import { resolveMentionedCollaborationAgentTargetWithSharedCloudAgentRefresh, resolveMentionedLocalAgentTarget, type MentionScopeConversation } from './mentions';

export async function resolvePreferredAgentMentionTarget(
  text: string,
  desktopChatState: DesktopChatState | null,
  collaborationState: DesktopCollaborationState | null,
  conversation: MentionScopeConversation | null | undefined,
  sharedCloudAgents: SharedCloudAgentSummary[],
  refreshSharedCloudAgents: (() => Promise<SharedCloudAgentSummary[]>) | undefined,
  skip: boolean,
  canResolveLocal: boolean,
) {
  const localTarget = !skip && canResolveLocal
    ? resolveMentionedLocalAgentTarget(text, desktopChatState, collaborationState)
    : null;
  return localTarget ?? (skip ? null : resolveMentionedCollaborationAgentTargetWithSharedCloudAgentRefresh(
    text, collaborationState, conversation, sharedCloudAgents, refreshSharedCloudAgents,
  ));
}

export function cloudAgentMentionIdentity(target: ResolvedMentionedCollaborationTarget | null) {
  const ownerAccountId = target?.peer.humanId?.trim() || target?.peer.nodeId?.trim() || '';
  const agentId = target?.peer.agentId?.trim() || '';
  const targetCloudAgentId = target
    ? agentId.startsWith('cloud_agent_') || agentId.startsWith('cloud-agent:')
      ? agentId
      : defaultCloudAgentId(ownerAccountId)
    : null;
  return {
    targetCloudAgentId,
    targetCloudAgentName: targetCloudAgentId
      ? stripSelfPossessivePrefix(target?.displayLabel, target?.peer.ownerName) || 'Kordi'
      : null,
    ownerAccountId: targetCloudAgentId ? ownerAccountId : null,
  };
}

export function resolveCloudAgentMentionTargetIds(
  isGroup: boolean,
  groupTargetIds: string[],
  mentionedOwnerAccountId: string | null,
) {
  return isGroup
    ? [...new Set([...groupTargetIds, ...(mentionedOwnerAccountId ? [mentionedOwnerAccountId] : [])])]
    : mentionedOwnerAccountId ? [mentionedOwnerAccountId] : [];
}
