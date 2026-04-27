export const LOCAL_DRAFT_CHAT_CONVERSATION_ID = 'draft:local-chat';
const PROJECT_DRAFT_SESSION_PREFIX = 'draft:project:';

export function isLocalDraftChatConversationId(value?: string | null) {
  return (value ?? '').trim() === LOCAL_DRAFT_CHAT_CONVERSATION_ID;
}

export function projectDraftSessionId(projectId: string) {
  return `${PROJECT_DRAFT_SESSION_PREFIX}${encodeURIComponent(projectId)}`;
}

export function isProjectDraftSessionId(value?: string | null) {
  return (value ?? '').trim().startsWith(PROJECT_DRAFT_SESSION_PREFIX);
}
