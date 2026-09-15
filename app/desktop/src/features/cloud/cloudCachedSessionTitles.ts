import { chatSyncSessionTitle, type ChatSyncConversation } from './authClient';
import type { CloudSessionTitlesById } from './cloudDiffSync';

export function cloudCachedSessionTitles(conversations: ChatSyncConversation[]): CloudSessionTitlesById {
  return conversations.reduce<CloudSessionTitlesById>((titles, conversation) => {
      const sessionId = conversation.legacy_session_id ?? conversation.id;
      const title = chatSyncSessionTitle(conversation);
      if (!title) return titles;
      titles[sessionId] = {
        sessionId,
        title,
        titleSource: conversation.preferences.personal_title ? 'manual' as const : 'external' as const,
        titleRevision: conversation.version,
        titlePolicyVersion: 1,
        titleGeneratedFromMessageId: null,
        updatedAtMs: Date.parse(conversation.updated_at) || Date.now(),
        updatedByAccountId: conversation.created_by_account_id,
        updatedAt: conversation.updated_at,
      };
      return titles;
    }, {});
}
