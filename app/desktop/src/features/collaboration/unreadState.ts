import { isInboundCollaborationMessageDirection } from '@/features/collaboration/messages';
import type { DesktopCollaborationConversation, DesktopCollaborationConversationMessage } from '@/kordi-app/types';

function isVisibleCollaborationUnreadMessage(message: DesktopCollaborationConversationMessage) {
  const contextPolicy = message.outreach?.contextPolicy?.trim().toLowerCase();
  return contextPolicy !== 'session-invite' && contextPolicy !== 'session-update' && contextPolicy !== 'session-title-update';
}

export function collaborationUnreadByParentSessionId(conversation: DesktopCollaborationConversation) {
  const unreadCount = Math.max(0, conversation.unreadCount);
  if (unreadCount <= 0) return undefined;

  const unreadByParentSessionId: Record<string, number> = {};
  let countedUnreadMessages = 0;
  for (const message of [...conversation.messages].reverse()) {
    if (countedUnreadMessages >= unreadCount) break;
    if (!isInboundCollaborationMessageDirection(message.direction)) continue;
    countedUnreadMessages += 1;
    if (!isVisibleCollaborationUnreadMessage(message)) continue;
    const parentSessionId = message.outreach?.parentSessionId?.trim()
      || conversation.outreach?.parentSessionId?.trim()
      || conversation.canonicalSessionId?.trim();
    if (!parentSessionId) continue;
    unreadByParentSessionId[parentSessionId] = (unreadByParentSessionId[parentSessionId] ?? 0) + 1;
  }
  return Object.keys(unreadByParentSessionId).length > 0 ? unreadByParentSessionId : undefined;
}

type UnreadMentionConversation = {
  unreadCount: number;
  identity?: { localHumanId?: string | null } | null;
  messages: Array<Pick<DesktopCollaborationConversationMessage, 'direction' | 'mentions' | 'messageAction'>>;
};

export function collaborationUnreadMentionCount(conversation: UnreadMentionConversation) {
  const localHumanId = conversation.identity?.localHumanId?.trim();
  const unreadCount = Math.max(0, conversation.unreadCount);
  if (!localHumanId || unreadCount <= 0) return 0;

  let countedUnreadMessages = 0;
  let mentionCount = 0;
  for (let index = conversation.messages.length - 1; index >= 0 && countedUnreadMessages < unreadCount; index -= 1) {
    const message = conversation.messages[index];
    if (!message || !isInboundCollaborationMessageDirection(message.direction)) continue;
    countedUnreadMessages += 1;
    if (message.messageAction?.kind === 'forward') continue;
    if (message.mentions?.some((mention) => mention.targetKind === 'person'
      && (mention.targetIdentityId === `human:${localHumanId}` || mention.humanId === localHumanId))) {
      mentionCount += 1;
    }
  }
  return mentionCount;
}
