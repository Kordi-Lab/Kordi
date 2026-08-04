import type { Message } from '@/kordi-app/types';
import {
  KORDI_SUPPORT_AVATAR_URL,
  KORDI_SUPPORT_NAME,
} from './supportIdentity';

export function normalizeSupportContactMessages(messages: Message[]) {
  return messages.map((message) => {
    if (message.role !== 'owned-agent' && message.role !== 'external-agent') return message;
    return {
      ...message,
      role: 'external-agent' as const,
      sender: KORDI_SUPPORT_NAME,
      sourceSenderLabel: KORDI_SUPPORT_NAME,
      senderType: 'agent' as const,
      senderProfileImageUrl: KORDI_SUPPORT_AVATAR_URL,
      isOwnMessage: false,
      showSenderMeta: true,
    };
  });
}
