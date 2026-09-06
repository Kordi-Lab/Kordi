import type { Conversation } from '@/kordi-app/types';
import { isKordiSupportConversation } from '@/features/support/supportIdentity';

export function activeConversationMatchesSendScope(
  activeConversationId: string,
  scope: Partial<Pick<Conversation, 'id' | 'canonicalSessionId'>> | null | undefined,
) {
  if (!scope) return true;
  const selectedId = activeConversationId.trim();
  if (!selectedId) return false;
  if ([scope.id, scope.canonicalSessionId]
    .some((value) => value?.trim() === selectedId)) return true;
  return isKordiSupportConversation({ id: selectedId })
    && isKordiSupportConversation(scope);
}

export function claimConversationSend(inFlightConversationIds: Set<string>, conversationId: string) {
  const id = conversationId.trim();
  if (!id || inFlightConversationIds.has(id)) return false;
  inFlightConversationIds.add(id);
  return true;
}

export function releaseConversationSend(inFlightConversationIds: Set<string>, conversationId: string) {
  inFlightConversationIds.delete(conversationId.trim());
}

export function collaborationConversationSendPlan({
  activeConvId,
  hasMaterializedCollaborationConversation,
  existingTargetConversationId,
  shouldStayInCanonicalSession,
}: {
  activeConvId: string;
  hasMaterializedCollaborationConversation: boolean;
  existingTargetConversationId?: string | null;
  shouldStayInCanonicalSession: boolean;
}) {
  const targetConversationId = hasMaterializedCollaborationConversation
    ? activeConvId
    : existingTargetConversationId ?? null;
  return {
    targetConversationId,
    shouldOpenBeforeOptimisticSend: !targetConversationId && !shouldStayInCanonicalSession,
    canAppendCollaborationOptimisticMessage: Boolean(targetConversationId),
  };
}
