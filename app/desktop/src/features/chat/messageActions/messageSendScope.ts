import type { Conversation } from '@/kordi-app/types';

export function activeConversationMatchesSendScope(
  activeConversationId: string,
  scope: Partial<Pick<Conversation, 'id' | 'canonicalSessionId'>> | null | undefined,
) {
  if (!scope) return true;
  const selectedId = activeConversationId.trim();
  return Boolean(selectedId && [scope.id, scope.canonicalSessionId]
    .some((value) => value?.trim() === selectedId));
}
