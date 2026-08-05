import type { Message } from '@/kordi-app/types';
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

export function normalizeSupportContactMessages(messages: Message[]) {
  return messages.filter((message) => !isStaleLocalProviderFailure(message)).map((message) => {
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
