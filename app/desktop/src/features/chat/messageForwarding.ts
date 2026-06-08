import type { Conversation } from '@/kordi-app/types';

import { forwardMessageAction, type MessageActionSource } from './messageActionMetadata';

export type ForwardDestination = {
  id: string;
  conversationId: string;
  label: string;
  subtitle: string;
};

export function buildForwardDestinations(
  conversations: Conversation[],
  excludedConversationId?: string | null,
): ForwardDestination[] {
  return conversations
    .map((conversation) => ({
      id: conversation.canonicalSessionId ?? conversation.id,
      label: conversation.name?.trim() || 'Untitled chat',
      subtitle: conversation.subtitle?.trim() || '',
      conversationId: conversation.id,
    }))
    .filter((destination) => destination.id && destination.id !== excludedConversationId && destination.conversationId !== excludedConversationId)
    .map(({ id, conversationId, label, subtitle }) => ({ id, conversationId, label, subtitle }));
}


export function createForwardedMessageDraft({
  source,
  caption,
}: {
  source: MessageActionSource;
  caption?: string;
  destinationSessionId: string;
}) {
  const text = caption?.trim()
    || source.textPreview
    || `${source.attachmentCount} attachment${source.attachmentCount === 1 ? '' : 's'}`;
  const messageAction = forwardMessageAction(source);
  return {
    text,
    forwardedFrom: source,
    messageAction,
  };
}

export function revealForwardedMessageInDestination({
  destinationConversationId,
  forwardedMessageId,
  setActiveConversationId,
  revealMessage,
  revealLatest,
  defer = (callback) => window.setTimeout(callback, 80),
}: {
  destinationConversationId: string;
  forwardedMessageId?: string | null;
  setActiveConversationId: (conversationId: string) => void;
  revealMessage: (messageId: string) => boolean | void;
  revealLatest?: () => boolean | void;
  defer?: (callback: () => void) => void;
}) {
  setActiveConversationId(destinationConversationId);
  if (forwardedMessageId?.trim()) {
    defer(() => { revealMessage(forwardedMessageId); });
    return;
  }
  revealLatest?.();
}
