import type { DesktopCollaborationState } from '@/kordi-app/types';

export function reconcileOptimisticCollaborationMessage(
  current: DesktopCollaborationState | null,
  conversationId: string,
  optimisticMessageId: string,
  canonicalMessage: { messageId: string; clientMessageId?: string | null },
): DesktopCollaborationState | null {
  if (!current) return current;
  return {
    ...current,
    conversations: current.conversations.map((conversation) => {
      if (conversation.id !== conversationId) return conversation;
      return {
        ...conversation,
        messages: conversation.messages.map((message) => message.id === optimisticMessageId
          ? {
              ...message,
              id: canonicalMessage.messageId,
              clientMessageId: canonicalMessage.clientMessageId
                ?? message.clientMessageId
                ?? optimisticMessageId,
              deliveryState: 'delivered',
              detail: undefined,
            }
          : message),
      };
    }),
  };
}

export function reconcileOptimisticCollaborationMessageUpdater(
  conversationId: string,
  optimisticMessageId: string,
  canonicalMessage: { messageId: string; clientMessageId?: string | null },
) {
  return (current: DesktopCollaborationState | null) => reconcileOptimisticCollaborationMessage(
    current,
    conversationId,
    optimisticMessageId,
    canonicalMessage,
  );
}
