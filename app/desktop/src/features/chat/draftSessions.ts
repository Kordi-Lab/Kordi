export const LOCAL_DRAFT_CHAT_CONVERSATION_ID = 'draft:local-chat';
export const EMPTY_CHAT_SELECTION_ID = 'empty:chat-selection';
const PROJECT_DRAFT_SESSION_PREFIX = 'draft:project:';

const BLANK_AGENT_SESSION_TITLES = new Set([
  '',
  'kordi',
  'my agent',
  'my agent session',
  'my kordi',
  'my kordi session',
  'new chat',
  'new session',
  'session',
  'untitled session',
]);

export function isLocalDraftChatConversationId(value?: string | null) {
  return (value ?? '').trim() === LOCAL_DRAFT_CHAT_CONVERSATION_ID;
}

export function isEmptyChatSelectionId(value?: string | null) {
  return (value ?? '').trim() === EMPTY_CHAT_SELECTION_ID;
}

export function isUnmaterializedDesktopAgentSession(session: {
  draft: boolean;
  messageCount: number;
  messages?: readonly unknown[];
  title: string;
}) {
  if (session.messageCount > 0 || (session.messages?.length ?? 0) > 0) {
    return false;
  }
  return session.draft
    || BLANK_AGENT_SESSION_TITLES.has(session.title.trim().toLowerCase());
}

export function projectDraftSessionId(projectId: string) {
  return `${PROJECT_DRAFT_SESSION_PREFIX}${encodeURIComponent(projectId)}`;
}

export function isProjectDraftSessionId(value?: string | null) {
  return (value ?? '').trim().startsWith(PROJECT_DRAFT_SESSION_PREFIX);
}
