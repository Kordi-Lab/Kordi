import { COLLABORATION_MESSAGE_DIRECTION_OUTBOUND } from '@/features/collaboration/messages';
import { isCollaborationAgentRuntime } from '@/features/collaboration/runtime';
import type { ComposerQuoteState, ConversationCollaborationTarget, DesktopCollaborationConversation, DesktopCollaborationState, MessageMention } from '@/kordi-app/types';
import type { AttachmentItem } from '../composerController.types';
import { composerMessageAction } from '../messageActionMetadata';
import { optimisticAttachmentContent } from './optimisticAttachments';

export function appendOptimisticCollaborationMessage(
  current: DesktopCollaborationState | null,
  conversationId: string,
  text: string,
  sentAt: string,
  optimisticMessageId: string,
  attachments: AttachmentItem[] = [],
  subtitleText = text,
  quote: ComposerQuoteState | null = null,
  mentions: MessageMention[] = [],
): DesktopCollaborationState | null {
  if (!current) return current;

  const timestampMs = Date.now();
  const quoteAction = quote?.source ? composerMessageAction(quote) : null;
  const attachmentContent = optimisticAttachmentContent(attachments);
  const nextConversations = current.conversations.map((conversation) => {
    if (conversation.id !== conversationId) return conversation;
    const expectsAgentReply = Boolean(conversation.supportTicketEnabled)
      || isCollaborationAgentRuntime(conversation.peerRuntime)
      || mentions.some((mention) => mention.targetKind === 'agent');
    return {
      ...conversation,
      subtitle: subtitleText,
      updatedAtMs: timestampMs,
      updatedAtLabel: sentAt,
      awaitingReply: expectsAgentReply,
      messages: [
        ...conversation.messages,
        {
          id: optimisticMessageId,
          clientMessageId: optimisticMessageId,
          direction: COLLABORATION_MESSAGE_DIRECTION_OUTBOUND,
          sender: 'Me',
          text,
          timeLabel: sentAt,
          timestampMs,
          requestId: expectsAgentReply ? optimisticMessageId : null,
          deliveryState: 'sending',
          ...attachmentContent,
          messageKind: attachmentContent.voiceMessage ? 'voice' : 'text',
          mentions,
          messageAction: quoteAction,
        },
      ],
    };
  }).sort((a, b) => b.updatedAtMs - a.updatedAtMs);

  return {
    ...current,
    conversations: nextConversations,
  };
}

export function markOptimisticCollaborationMessageFailed(
  current: DesktopCollaborationState | null,
  conversationId: string,
  optimisticMessageId: string,
  detail?: string | null,
): DesktopCollaborationState | null {
  if (!current) return current;

  return {
    ...current,
    conversations: current.conversations.map((conversation) => {
      if (conversation.id !== conversationId) return conversation;
      return {
        ...conversation,
        awaitingReply: false,
        messages: conversation.messages.map((message) => (
          message.id === optimisticMessageId
            ? {
                ...message,
                deliveryState: 'failed',
                detail: detail?.trim() || message.detail,
              }
            : message
        )),
      };
    }),
  };
}

export function markOptimisticCollaborationMessageSending(
  current: DesktopCollaborationState | null,
  conversationId: string,
  messageId: string,
): DesktopCollaborationState | null {
  if (!current) return current;

  return {
    ...current,
    conversations: current.conversations.map((conversation) => {
      if (conversation.id !== conversationId) return conversation;
      return {
        ...conversation,
        messages: conversation.messages.map((message) => (
          message.id === messageId
            ? {
                ...message,
                deliveryState: 'sending',
                detail: undefined,
              }
            : message
        )),
      };
    }),
  };
}

export function findCollaborationConversationForTarget(
  state: DesktopCollaborationState,
  target: ConversationCollaborationTarget,
): DesktopCollaborationConversation | null {
  const normalizedRuntime = target.runtime?.trim().toLowerCase();
  return state.conversations.find((conversation) => (
    conversation.hostId === target.hostId
    && conversation.peerNodeId === target.nodeId
    && (!normalizedRuntime || conversation.peerRuntime.trim().toLowerCase() === normalizedRuntime)
  )) ?? null;
}
