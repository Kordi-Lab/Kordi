import type { Conversation } from '@/kordi-app/types';

export const CHAT_AGENT_COMPOSER_PLACEHOLDER = 'Ask your agent…';
export const CHAT_CONTACT_COMPOSER_PLACEHOLDER = 'Send your message, use @ to mention…';

export function chatComposerPlaceholder(conversation: Pick<Conversation, 'type'>) {
  return conversation.type === 'owned-agent' || conversation.type === 'external-agent'
    ? CHAT_AGENT_COMPOSER_PLACEHOLDER
    : CHAT_CONTACT_COMPOSER_PLACEHOLDER;
}
