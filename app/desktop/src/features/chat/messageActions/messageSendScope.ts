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
