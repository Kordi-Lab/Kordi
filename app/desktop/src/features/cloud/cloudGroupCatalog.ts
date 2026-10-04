import type { CloudMessage } from './cloudMessageTypes';
import type { ChatSyncConversation } from './chatSyncTypes';
import { isCloudGroupSessionId, type CloudGroupControlEnvelope } from './cloudGroupMessages';

/** A directory entry can establish a group without a transcript message. */
export function cloudGroupCatalogRow(conversation: ChatSyncConversation, accountId: string) {
  const groupId = conversation.legacy_session_id?.trim() || conversation.id.trim();
  if (conversation.kind !== 'group' || !isCloudGroupSessionId(groupId)) return null;
  const participants = conversation.members
    .filter(member => member.membership_state === 'active')
    .map(member => ({
      accountId: member.account_id,
      displayName: member.display_name?.trim() || member.account_id,
      avatarUrl: member.avatar_url ?? null,
      agentId: member.default_agent_id ?? null,
      agentDisplayName: member.default_agent_display_name ?? null,
      agentAvatarUrl: member.default_agent_avatar_url ?? null,
      role: member.role,
      joinedAt: member.joined_at,
    }));
  if (!participants.some(member => member.accountId === accountId)) return null;
  const actor = participants.find(member => member.accountId === conversation.created_by_account_id)
    ?? participants.find(member => member.role === 'owner' || member.role === 'admin')
    ?? participants[0];
  const envelope: CloudGroupControlEnvelope = {
    kind: 'group-invite',
    groupId,
    groupSpaceId: conversation.group_space_id ?? groupId,
    groupTitle: conversation.group_title ?? conversation.shared_title,
    groupAvatar: conversation.group_avatar,
    createdByAccountId: conversation.created_by_account_id,
    actor,
    participants,
    sessionTitleSyncOnly: true,
    ...(conversation.shared_title?.trim() ? {
      sessionTitle: {
        title: conversation.shared_title.trim(),
        titleSource: 'manual' as const,
        titleRevision: conversation.version,
        titlePolicyVersion: 1,
        updatedAtMs: Date.parse(conversation.updated_at),
        updatedByAccountId: actor.accountId,
      },
    } : {}),
  };
  // This context is used only to establish the session shell. It is never
  // inserted into either the wire-message cache or the transcript.
  const wire: CloudMessage = {
    messageId: `catalog:${conversation.id}:${conversation.version}`,
    fromAccountId: actor.accountId,
    toAccountId: accountId,
    body: '',
    createdAt: conversation.updated_at,
    deliveredAt: null,
    readAt: null,
    direction: actor.accountId === accountId ? 'outgoing' : 'incoming',
    sessionId: groupId,
    conversationId: conversation.id,
  };
  return { wire, envelope, conversation };
}
