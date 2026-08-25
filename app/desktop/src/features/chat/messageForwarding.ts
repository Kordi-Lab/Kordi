import type { Conversation } from '@/kordi-app/types';
import { conversationChatKindLabel } from './sessionKindLabels';

import {
  forwardMessageAction,
  type ForwardMessageSource,
} from './messageActionMetadata';

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
      subtitle: conversationChatKindLabel(conversation),
      conversationId: conversation.id,
    }))
    .filter((destination) => destination.id && destination.id !== excludedConversationId && destination.conversationId !== excludedConversationId)
    .map(({ id, conversationId, label, subtitle }) => ({ id, conversationId, label, subtitle }));
}


export function createForwardedMessageDraft({
  source,
  caption,
}: {
  source: ForwardMessageSource;
  caption?: string;
  destinationSessionId: string;
}) {
  const text = caption?.trim()
    || (source.attachmentOnly ? '' : source.textPreview)
    || (source.attachments.length === 0
      ? `${source.attachmentCount} attachment${source.attachmentCount === 1 ? '' : 's'}`
      : '');
  const messageAction = forwardMessageAction(source);
  return {
    text,
    attachments: source.attachments.map((attachment) => ({ ...attachment })),
    voiceMessage: source.voiceMessage ?? null,
    forwardedFrom: messageAction.source,
    messageAction,
  };
}

export function createForwardedMessageDrafts({
  sources,
  caption,
}: {
  sources: ForwardMessageSource[];
  caption?: string;
}) {
  return sources.map((source, index) => createForwardedMessageDraft({
    source,
    caption: sources.length === 1 && index === 0 ? caption : '',
    destinationSessionId: source.sourceSessionId,
  }));
}

export function orderedForwardSourcesForMessageIds(
  orderedMessageIds: string[],
  sourcesByMessageId: ReadonlyMap<string, ForwardMessageSource>,
): ForwardMessageSource[] {
  const result: ForwardMessageSource[] = [];
  orderedMessageIds.forEach((messageId) => {
    const source = sourcesByMessageId.get(messageId);
    if (source) result.push(source);
  });
  return result;
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
