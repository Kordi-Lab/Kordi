export const LOCAL_DRAFT_CHAT_CONVERSATION_ID = 'draft:local-chat';

export function isLocalDraftChatConversationId(value?: string | null) {
  return (value ?? '').trim() === LOCAL_DRAFT_CHAT_CONVERSATION_ID;
}
