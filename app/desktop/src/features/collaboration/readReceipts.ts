import { isInboundCollaborationMessageDirection } from '@/features/collaboration/messages';
import type { DesktopCollaborationConversation } from '@/kordi-app/types';

export const COLLABORATION_READ_ATTENTION_EVENTS = ['focus', 'visibilitychange', 'pageshow'] as const;

type CollaborationReadDocumentLike = {
  visibilityState?: string;
  hasFocus?: () => boolean;
};

export function canAutoMarkCollaborationRead(documentLike: CollaborationReadDocumentLike | null | undefined) {
  return documentLike?.visibilityState === 'visible'
    && Boolean(documentLike.hasFocus?.());
}

function collaborationConversationSessionKeys(conversation: DesktopCollaborationConversation) {
  return [
    conversation.id,
    conversation.canonicalSessionId?.trim(),
    conversation.outreach?.parentSessionId?.trim(),
  ].filter((value): value is string => Boolean(value));
}

function collaborationConversationMatchesSession(conversation: DesktopCollaborationConversation, normalizedActiveSessionId: string) {
  return collaborationConversationSessionKeys(conversation).includes(normalizedActiveSessionId);
}

export function activeCollaborationConversationsForSession(
  conversations: DesktopCollaborationConversation[],
  activeSessionId: string,
) {
  const normalizedActiveSessionId = activeSessionId.trim();
  if (!normalizedActiveSessionId) return [];
  return conversations.filter((conversation) => collaborationConversationMatchesSession(conversation, normalizedActiveSessionId));
}

export function activeCollaborationConversationForSession(
  conversations: DesktopCollaborationConversation[],
  activeSessionId: string,
) {
  return activeCollaborationConversationsForSession(conversations, activeSessionId)[0] ?? null;
}

export function inboundCollaborationRequestIds(conversation: DesktopCollaborationConversation) {
  return Array.from(new Set(
    conversation.messages
      .filter((message) => isInboundCollaborationMessageDirection(message.direction))
      .map((message) => message.requestId?.trim())
      .filter((requestId): requestId is string => Boolean(requestId)),
  )).sort();
}

export function shouldMarkCollaborationConversationRead(conversation: DesktopCollaborationConversation) {
  return conversation.unreadCount > 0 || inboundCollaborationRequestIds(conversation).length > 0;
}

export function activeUnreadCollaborationConversationsForSession(
  conversations: DesktopCollaborationConversation[],
  activeSessionId: string,
) {
  return activeCollaborationConversationsForSession(conversations, activeSessionId)
    .filter(shouldMarkCollaborationConversationRead);
}

export function collaborationConversationIdsToMarkReadOnUserActivity(
  conversations: DesktopCollaborationConversation[],
  activeSessionId: string,
) {
  return activeUnreadCollaborationConversationsForSession(conversations, activeSessionId)
    .map((conversation) => conversation.id);
}

export function collaborationReadReceiptSignature(conversation: DesktopCollaborationConversation) {
  return [
    conversation.id,
    ...inboundCollaborationRequestIds(conversation),
  ].join(':');
}

export function collaborationReadReceiptBatchSignature(conversations: DesktopCollaborationConversation[]) {
  return conversations
    .map(collaborationReadReceiptSignature)
    .sort()
    .join('|');
}
