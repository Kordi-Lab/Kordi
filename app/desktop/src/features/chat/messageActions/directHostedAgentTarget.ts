import type { ConversationCollaborationTarget } from '@/kordi-app/types';

import type { ResolvedMentionedCollaborationTarget } from './types';

export type DirectHostedAgentTarget = {
  targetCloudAgentId: string;
  targetCloudAgentName: string | null;
  targetCloudAgentOwnerAccountId: string | null;
  targetCloudAgentOwnerName: string | null;
};

export function resolveDirectHostedAgentTarget({
  mentionedAgentId,
  mentionedTarget,
  activeTarget,
}: {
  mentionedAgentId: string | null;
  mentionedTarget: ResolvedMentionedCollaborationTarget | null;
  activeTarget: ConversationCollaborationTarget | null | undefined;
}): DirectHostedAgentTarget | null {
  const activeAgentId = activeTarget?.agentId?.trim() ?? '';
  const directAgentId = mentionedAgentId
    ?? (activeAgentId.startsWith('cloud_agent_') ? activeAgentId : null);
  if (!directAgentId) return null;

  return {
    targetCloudAgentId: directAgentId,
    targetCloudAgentName: mentionedAgentId
      ? mentionedTarget?.displayLabel ?? null
      : activeTarget?.displayName ?? null,
    targetCloudAgentOwnerAccountId: mentionedAgentId
      ? mentionedTarget?.peer.humanId ?? mentionedTarget?.peer.nodeId ?? null
      : activeTarget?.humanId ?? activeTarget?.nodeId ?? null,
    targetCloudAgentOwnerName: mentionedAgentId
      ? mentionedTarget?.peer.ownerName ?? null
      : activeTarget?.ownerName ?? null,
  };
}
