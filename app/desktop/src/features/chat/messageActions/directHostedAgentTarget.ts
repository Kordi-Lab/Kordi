import {
  cloudCollaborationConversationId,
  cloudPeerAccountIdFromConversationId,
  cloudSessionIdFromConversationId,
  isCloudCollaborationConversationId,
  isCloudSystemAgentSessionId,
} from '@/features/collaboration/conversationIds';
import {
  isKordiSupportConversation,
  KORDI_SUPPORT_AGENT_ID,
  KORDI_SUPPORT_NAME,
} from '@/features/support/supportIdentity';
import type { ConversationCollaborationTarget } from '@/kordi-app/types';

import type { ResolvedMentionedCollaborationTarget } from './types';

export type DirectHostedAgentTarget = {
  targetCloudAgentId: string;
  targetCloudAgentName: string | null;
  targetCloudAgentOwnerAccountId: string | null;
  targetCloudAgentOwnerName: string | null;
};

export type LockedHostedAgentTarget = {
  agentId: string;
  name: string;
  ownerAccountId: string | null;
  ownerName: string | null;
};

export function resolvedCloudConversationIdForCollaborationSend(
  conversationId: string,
  canonicalSessionId?: string | null,
  resolvedPeerAccountId?: string | null,
): string {
  if (
    !isCloudCollaborationConversationId(conversationId)
    || cloudSessionIdFromConversationId(conversationId)
  ) return conversationId;

  const normalizedSessionId = canonicalSessionId?.trim() ?? '';
  if (!isCloudSystemAgentSessionId(normalizedSessionId)) return conversationId;
  const peerAccountId = resolvedPeerAccountId?.trim()
    || cloudPeerAccountIdFromConversationId(conversationId);
  if (!peerAccountId) return conversationId;
  return cloudCollaborationConversationId(peerAccountId, 'agent', normalizedSessionId);
}

export function resolveLockedKordiSupportAgentTarget({
  conversationId,
  resolvedConversationId,
  canonicalSessionId,
  supportTicketEnabled,
  activeTarget,
}: {
  conversationId: string;
  resolvedConversationId: string;
  canonicalSessionId?: string | null;
  supportTicketEnabled?: boolean;
  activeTarget: ConversationCollaborationTarget | null | undefined;
}): LockedHostedAgentTarget | null {
  if (!isKordiSupportConversation({
    id: conversationId,
    canonicalSessionId,
    supportTicketEnabled,
    collaborationTarget: activeTarget,
  })) return null;

  return {
    agentId: KORDI_SUPPORT_AGENT_ID,
    name: KORDI_SUPPORT_NAME,
    ownerAccountId: activeTarget?.humanId?.trim()
      || activeTarget?.nodeId?.trim()
      || cloudPeerAccountIdFromConversationId(resolvedConversationId)
      || cloudPeerAccountIdFromConversationId(conversationId)
      || null,
    ownerName: activeTarget?.ownerName?.trim() || 'Kordi',
  };
}

export function resolveLockedKordiSupportCloudConversationId({
  resolvedConversationId,
  canonicalSessionId,
  lockedTarget,
}: {
  resolvedConversationId: string;
  canonicalSessionId?: string | null;
  lockedTarget: LockedHostedAgentTarget | null;
}): string | null {
  const ownerAccountId = lockedTarget?.ownerAccountId?.trim() ?? '';
  if (!ownerAccountId) return null;

  const resolvedPeerAccountId = cloudPeerAccountIdFromConversationId(
    resolvedConversationId,
  );
  const resolvedSessionId = cloudSessionIdFromConversationId(
    resolvedConversationId,
  );
  if (
    isCloudCollaborationConversationId(resolvedConversationId)
    && resolvedPeerAccountId === ownerAccountId
    && (resolvedSessionId || !canonicalSessionId?.trim())
  ) {
    return resolvedConversationId;
  }

  return cloudCollaborationConversationId(
    ownerAccountId,
    'agent',
    resolvedSessionId ?? canonicalSessionId,
  );
}

export function resolveDirectHostedAgentTarget({
  mentionedAgentId,
  mentionedTarget,
  activeTarget,
  lockedTarget,
}: {
  mentionedAgentId: string | null;
  mentionedTarget: ResolvedMentionedCollaborationTarget | null;
  activeTarget: ConversationCollaborationTarget | null | undefined;
  lockedTarget?: LockedHostedAgentTarget | null;
}): DirectHostedAgentTarget | null {
  if (lockedTarget) {
    return {
      targetCloudAgentId: lockedTarget.agentId,
      targetCloudAgentName: lockedTarget.name,
      targetCloudAgentOwnerAccountId: lockedTarget.ownerAccountId,
      targetCloudAgentOwnerName: lockedTarget.ownerName,
    };
  }

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
