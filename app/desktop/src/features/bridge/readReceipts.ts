import { isInboundBridgeMessageDirection } from '@/features/bridge/messages';
import type { DesktopBridgeConversation } from '@/kordi-app/types';

export const BRIDGE_READ_ATTENTION_EVENTS = ['focus', 'visibilitychange', 'pageshow'] as const;

type BridgeReadDocumentLike = {
  visibilityState?: string;
  hasFocus?: () => boolean;
};

export function canAutoMarkBridgeRead(documentLike: BridgeReadDocumentLike | null | undefined, shouldAutoFollow: boolean) {
  return documentLike?.visibilityState === 'visible'
    && Boolean(documentLike.hasFocus?.())
    && shouldAutoFollow;
}

export function activeBridgeConversationForSession(
  conversations: DesktopBridgeConversation[],
  activeSessionId: string,
) {
  const normalizedActiveSessionId = activeSessionId.trim();
  return conversations.find((conversation) => (
    conversation.id === normalizedActiveSessionId
    || conversation.canonicalSessionId === normalizedActiveSessionId
    || conversation.outreach?.parentSessionId?.trim() === normalizedActiveSessionId
  )) ?? null;
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

export function bridgeReadReceiptSignature(conversation: DesktopBridgeConversation) {
  return [
    conversation.id,
    Math.max(0, conversation.unreadCount),
    ...inboundBridgeRequestIds(conversation),
  ].join(':');
}
