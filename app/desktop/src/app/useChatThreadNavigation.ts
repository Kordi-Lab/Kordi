import { chatNavigationForConversation } from '@/features/chat/chatNavigation';
import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { requestThreadNavigation, useThreadNavigation } from '@/features/cloud/threadAttention';
import type { Conversation, NavId } from '@/kordi-app/types';

export function useChatThreadNavigation(
  conversations: readonly Conversation[],
  setActiveNav: Dispatch<SetStateAction<NavId>>,
  setActiveConvId: Dispatch<SetStateAction<string>>,
) {
  const threadNavigation = useThreadNavigation();
  const handledNonce = useRef<number | null>(null);
  const findConversation = useCallback((sessionId: string) => conversations.find((item) => (
    item.id === sessionId || item.canonicalSessionId === sessionId
  )), [conversations]);

  useEffect(() => {
    if (!threadNavigation || handledNonce.current === threadNavigation.nonce) return;
    handledNonce.current = threadNavigation.nonce;
    const conversation = findConversation(threadNavigation.sessionId);
    setActiveNav(chatNavigationForConversation(conversation));
    setActiveConvId(conversation?.id ?? threadNavigation.sessionId);
  }, [findConversation, setActiveConvId, setActiveNav, threadNavigation]);

  return useCallback((sessionId: string, messageId: string) => {
    const conversation = findConversation(sessionId);
    setActiveNav(chatNavigationForConversation(conversation));
    setActiveConvId(conversation?.id ?? sessionId);
    requestThreadNavigation(conversation?.canonicalSessionId ?? sessionId, messageId);
  }, [findConversation, setActiveConvId, setActiveNav]);
}
