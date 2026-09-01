import { defaultCloudAgentId } from '@/features/cloud/cloudAgentIdentity';
import { stripSelfPossessivePrefix } from '@/lib/identityLabels';
import type { SharedCloudAgentSummary } from '@/features/cloud/cloudAgents';
import type { DesktopChatState, DesktopCollaborationState } from '@/kordi-app/types';
import type { ResolvedMentionedCollaborationTarget } from './types';
import { localAgentMentionLabels, resolveMentionedCollaborationAgentTargetWithSharedCloudAgentRefresh, resolveMentionedCollaborationTarget, resolveMentionedLocalAgentTarget, type MentionScopeConversation } from './mentions';
import { mentionTextStartsWithLabel } from './localAgentMentions';
import { normalizeMentionLabel } from './mentionHandles';

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
  const activeHost = collaborationState?.hosts.find((host) => host.id === collaborationState.activeHostId)
    ?? collaborationState?.hosts[0]
    ?? null;
  const cachedRemoteTarget = skip ? null : resolveMentionedCollaborationTarget(
    text,
    collaborationState,
    conversation,
    {
      targetKind: 'agent',
      sharedCloudAgents,
      localAccountId: activeHost?.humanId ?? activeHost?.nodeId ?? null,
    },
  );
  const localCandidate = !skip && canResolveLocal
    ? resolveMentionedLocalAgentTarget(text, desktopChatState, collaborationState)
    : null;
  const afterAt = text.replace(/^\s*@/, '');
  const localTarget = localCandidate && localAgentMentionLabels(desktopChatState, collaborationState).some((label) => (
    normalizeMentionLabel(label) !== 'kordi' && mentionTextStartsWithLabel(afterAt, label)
  )) ? localCandidate : null;
  return cachedRemoteTarget ?? localTarget ?? (skip ? null : resolveMentionedCollaborationAgentTargetWithSharedCloudAgentRefresh(
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
