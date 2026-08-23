import { normalizedMessageMentions } from '@/features/chat/messageMentions';
import type { MessageMention } from '@/kordi-app/types';

export function canonicalMentions(value: unknown): MessageMention[] | undefined {
  return normalizedMessageMentions(value);
}
