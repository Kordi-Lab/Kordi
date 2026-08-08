import type { Conversation, Message } from '@/kordi-app/types';
import { isCloudAgentNoProviderConfiguredError } from '@/features/cloud/cloudAgentMessages';
import {
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

export function normalizeSupportContactMessages(messages: Message[]) {
  return messages.flatMap((message) => {
    if (isStaleLocalProviderFailure(message)) return [];
    if (message.role !== 'owned-agent' && message.role !== 'external-agent') return [message];

    const text = supportContactResponseText(message);
    if (!text.trim()) return [];

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
