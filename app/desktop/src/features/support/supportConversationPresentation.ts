import type { Conversation, Message } from '@/kordi-app/types';
import { isCloudAgentNoProviderConfiguredError } from '@/features/cloud/cloudAgentMessages';
import {
  isKordiSupportConversation,
  KORDI_SUPPORT_AVATAR_URL,
  KORDI_SUPPORT_NAME,
} from './supportIdentity';

function isStaleLocalProviderFailure(message: Message): boolean {
  if (message.role !== 'owned-agent' && message.role !== 'external-agent') return false;
  return [
    message.turn?.error,
    message.turn?.message,
    message.turn?.assistantText,
    message.detail,
    message.text,
  ].some((value) => isCloudAgentNoProviderConfiguredError(value));
}

function supportContactResponseText(message: Message): string {
  const candidates = [
    message.turn?.assistantText,
    message.turn?.error,
    message.text,
    message.detail,
  ];
  return candidates.find((value) => value?.trim()) ?? '';
}

function isPendingSupportContactResponse(message: Message): boolean {
  return Boolean(message.turn && !message.turn.completed && !message.turn.error?.trim());
}

export function normalizeSupportContactMessages(messages: Message[]) {
  return messages.flatMap((message) => {
    if (isStaleLocalProviderFailure(message)) return [];
    if (message.role !== 'owned-agent' && message.role !== 'external-agent') return [message];

    const text = supportContactResponseText(message);
    const supportContactTyping = !text.trim() && isPendingSupportContactResponse(message);
    if (!text.trim() && !supportContactTyping) return [];

    return [{
      ...message,
      role: 'person' as const,
      sender: KORDI_SUPPORT_NAME,
      sourceSenderLabel: KORDI_SUPPORT_NAME,
      senderType: 'human' as const,
      senderProfileImageUrl: KORDI_SUPPORT_AVATAR_URL,
      isOwnMessage: false,
      showSenderMeta: false,
      supportContactResponse: true,
      supportContactTyping,
      text,
      detail: undefined,
      replyToMessageId: undefined,
      sourceMessage: undefined,
      turn: undefined,
    }];
  });
}

export function normalizeSupportContactConversationPresentation(
  conversation: Conversation,
): Conversation {
  return {
    ...conversation,
    supportTicketEnabled: true,
    name: KORDI_SUPPORT_NAME,
    type: 'person',
    directness: 'Person chat',
    participants: ['Me', KORDI_SUPPORT_NAME],
    canonicalParticipants: undefined,
    profileImageUrl: KORDI_SUPPORT_AVATAR_URL,
    participantProfileImageUrls: {
      ...conversation.participantProfileImageUrls,
      [KORDI_SUPPORT_NAME]: KORDI_SUPPORT_AVATAR_URL,
    },
    messages: normalizeSupportContactMessages(conversation.messages),
  };
}

function supportConversationMessageCount(conversation: Conversation): number {
  const visibleMessageCount = conversation.messages.filter(
    (message) => message.role !== 'system',
  ).length;
  return Math.max(visibleMessageCount, conversation.canonicalMessageCount ?? 0);
}

function preferSupportConversation(
  current: Conversation,
  candidate: Conversation,
): Conversation {
  const currentMessageCount = supportConversationMessageCount(current);
  const candidateMessageCount = supportConversationMessageCount(candidate);
  if (currentMessageCount !== candidateMessageCount) {
    return candidateMessageCount > currentMessageCount ? candidate : current;
  }
  if (Boolean(current.transientDraft) !== Boolean(candidate.transientDraft)) {
    return candidate.transientDraft ? current : candidate;
  }
  return (candidate._updatedAtMs ?? 0) > (current._updatedAtMs ?? 0)
    ? candidate
    : current;
}

export function collapseDuplicateKordiSupportConversations(
  conversations: Conversation[],
): Conversation[] {
  const supportConversations = conversations.filter((conversation) => (
    isKordiSupportConversation(conversation)
  ));
  if (supportConversations.length <= 1) return conversations;

  const preferred = supportConversations.reduce(preferSupportConversation);
  return conversations.filter((conversation) => (
    !isKordiSupportConversation(conversation) || conversation === preferred
  ));
}
