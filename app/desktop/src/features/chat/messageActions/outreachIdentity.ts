import type {
ConversationCollaborationTarget
} from '@/kordi-app/types';
import type { ResolvedMentionedCollaborationTarget } from "./types";

export function outreachIdentityForCollaborationTarget(target: ResolvedMentionedCollaborationTarget) {
  const targetDisplayName = target.displayLabel;
  const targetOwnerName = target.peer.ownerName ?? null;
  const targetRuntime = target.peer.runtime;
  const targetHumanId = target.peer.humanId ?? null;
  const targetAgentId = target.peer.agentId ?? null;
  return {
    targetDisplayName,
    targetOwnerName,
    targetRuntime,
    targetHumanId,
    targetAgentId,
    selfTargetIdentity: {
      identityId: targetAgentId ? `agent:${targetAgentId}` : (targetHumanId ? `human:${targetHumanId}` : null),
      displayName: targetDisplayName,
      kind: target.targetKind === 'agent' ? 'agent' : 'human',
      ownerDisplayName: targetOwnerName,
      sourceIdentityId: target.peer.nodeId,
      humanId: targetHumanId,
      agentId: targetAgentId,
      runtime: targetRuntime,
    },
  };
}

export function mentionedPersonIsActiveCollaborationTarget(
  target: ResolvedMentionedCollaborationTarget,
  activeTarget?: ConversationCollaborationTarget | null,
) {
  if (target.targetKind !== 'person' || !activeTarget) return false;
  if (target.peer.humanId && activeTarget.humanId && target.peer.humanId === activeTarget.humanId) return true;
  return target.peer.nodeId === activeTarget.nodeId;
}
