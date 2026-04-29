import { isInboundBridgeMessageDirection } from '@/features/bridge/messages';
import type { DesktopBridgeConversation } from '@/kordi-app/types';

export const BRIDGE_READ_ATTENTION_EVENTS = ['focus', 'visibilitychange', 'pageshow'] as const;

type BridgeReadDocumentLike = {
  visibilityState?: string;
  hasFocus?: () => boolean;
};

export function canAutoMarkBridgeRead(documentLike: BridgeReadDocumentLike | null | undefined) {
  return documentLike?.visibilityState === 'visible'
    && Boolean(documentLike.hasFocus?.());
}

function bridgeConversationMatchesSession(conversation: DesktopBridgeConversation, normalizedActiveSessionId: string) {
  return conversation.id === normalizedActiveSessionId
    || conversation.canonicalSessionId === normalizedActiveSessionId
    || conversation.outreach?.parentSessionId?.trim() === normalizedActiveSessionId;
}

export function activeBridgeConversationsForSession(
  conversations: DesktopBridgeConversation[],
  activeSessionId: string,
) {
  const normalizedActiveSessionId = activeSessionId.trim();
  if (!normalizedActiveSessionId) return [];
  return conversations.filter((conversation) => bridgeConversationMatchesSession(conversation, normalizedActiveSessionId));
}

export function activeBridgeConversationForSession(
  conversations: DesktopBridgeConversation[],
  activeSessionId: string,
) {
  return activeBridgeConversationsForSession(conversations, activeSessionId)[0] ?? null;
}

export function inboundBridgeRequestIds(conversation: DesktopBridgeConversation) {
  return Array.from(new Set(
    conversation.messages
      .filter((message) => isInboundBridgeMessageDirection(message.direction))
      .map((message) => message.requestId?.trim())
      .filter((requestId): requestId is string => Boolean(requestId)),
  )).sort();
}

export function shouldMarkBridgeConversationRead(conversation: DesktopBridgeConversation) {
  return conversation.unreadCount > 0 || inboundBridgeRequestIds(conversation).length > 0;
}

export function activeUnreadBridgeConversationsForSession(
  conversations: DesktopBridgeConversation[],
  activeSessionId: string,
) {
  return activeBridgeConversationsForSession(conversations, activeSessionId)
    .filter(shouldMarkBridgeConversationRead);
}

export function bridgeReadReceiptSignature(conversation: DesktopBridgeConversation) {
  return [
    conversation.id,
    ...inboundBridgeRequestIds(conversation),
  ].join(':');
}

export function bridgeReadReceiptBatchSignature(conversations: DesktopBridgeConversation[]) {
  return conversations
    .map(bridgeReadReceiptSignature)
    .sort()
    .join('|');
}
