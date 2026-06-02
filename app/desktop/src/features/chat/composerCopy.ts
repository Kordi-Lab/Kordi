import type { Conversation } from '@/kordi-app/types';

export const CHAT_AGENT_COMPOSER_PLACEHOLDER = 'Ask your agent…';
export const CHAT_CONTACT_COMPOSER_PLACEHOLDER = 'Send your message, use @ to mention…';

export function chatComposerPlaceholder(conversation: Pick<Conversation, 'type' | 'directness'>) {
  const type = String(conversation.type ?? '').trim().toLowerCase();
  const directness = String(conversation.directness ?? '').trim().toLowerCase();
  if (type === 'group' || directness.includes('group')) return CHAT_CONTACT_COMPOSER_PLACEHOLDER;
  return type === 'owned-agent' || type === 'external-agent'
    ? CHAT_AGENT_COMPOSER_PLACEHOLDER
    : CHAT_CONTACT_COMPOSER_PLACEHOLDER;
}
