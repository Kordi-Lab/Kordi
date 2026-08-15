import {
  EMPTY_CHAT_SELECTION_ID,
  LOCAL_DRAFT_CHAT_CONVERSATION_ID,
  isLocalDraftChatConversationId,
} from '@/features/chat/draftSessions';
import { isUnmaterializedAgentConversation } from '@/features/chat/participantSpaces';
import type { Conversation } from '@/kordi-app/types';

export function materializedChatConversations(
  conversations: readonly Conversation[],
) {
  return conversations.filter(
    (conversation) => !isUnmaterializedAgentConversation(conversation),
  );
}

export function nativeChatPlaceholderForSelection(
  activeConversationId: string,
): Conversation {
  const isExplicitDraft = isLocalDraftChatConversationId(activeConversationId);
  return {
    id: isExplicitDraft
      ? LOCAL_DRAFT_CHAT_CONVERSATION_ID
      : EMPTY_CHAT_SELECTION_ID,
    canonicalSessionId: undefined,
    name: isExplicitDraft ? 'New session' : 'Chats',
    type: 'owned-agent',
    subtitle: '',
    unread: 0,
    collaborationSources: ['Local'],
    trust: 'Owned',
    directness: isExplicitDraft ? 'Draft' : '',
    participants: ['Me', 'My Kordi'],
    collaborationTarget: undefined,
    messages: [],
  };
}
