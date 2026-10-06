import { useEffect } from 'react';
import { isLocalDraftChatConversationId } from '@/features/chat/draftSessions';
import type { Conversation } from '@/kordi-app/types';

/** The canonical session whose history the side panel shows, if it has one. */
export function companionHistorySessionId(
  conversation: Pick<Conversation, 'id' | 'canonicalSessionId' | 'agentSubsessionId'> | null | undefined,
) {
  if (!conversation || conversation.agentSubsessionId || isLocalDraftChatConversationId(conversation.id)) return null;
  return conversation.canonicalSessionId?.trim() || conversation.id;
}

/** Reports the side panel's session so the app keeps its canonical history loaded. */
export function useCompanionHistorySession(
  conversation: Pick<Conversation, 'id' | 'canonicalSessionId' | 'agentSubsessionId'> | null | undefined,
  onChange: ((sessionId: string | null) => void) | undefined,
) {
  const sessionId = companionHistorySessionId(conversation);
  useEffect(() => {
    if (!onChange || !sessionId) return;
    onChange(sessionId);
    return () => onChange(null);
  }, [onChange, sessionId]);
}
