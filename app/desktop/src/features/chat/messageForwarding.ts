import type { Conversation } from '@/kordi-app/types';

import { forwardMessageAction, type MessageActionSource } from './messageActionMetadata';

export type ForwardDestination = {
  id: string;
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
      originalId: conversation.id,
    }))
    .filter((destination) => destination.id && destination.id !== excludedConversationId && destination.originalId !== excludedConversationId)
    .map(({ id, label, subtitle }) => ({ id, label, subtitle }));
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
