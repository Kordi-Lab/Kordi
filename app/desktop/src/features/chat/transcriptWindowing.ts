import type { Message } from '@/kordi-app/types';

export const TRANSCRIPT_WINDOW_OVERSCAN = 12;
export const TRANSCRIPT_WINDOW_ESTIMATED_MESSAGE_HEIGHT = 74;

export function transcriptWindowMessageIdentity(message: Message | undefined, fallbackIndex: number) {
  if (!message) return 'none';
  return message.id
    ?? message.entryId
    ?? message.turn?.id
    ?? `${fallbackIndex}:${message.role}:${message.sender}:${message.time}`;
}

export function transcriptWindowMessageMatchesId(
  message: Message | undefined,
  messageId: string,
  fallbackIndex: number,
) {
  if (!message || !messageId) return false;
  return message.id === messageId
    || message.entryId === messageId
    || message.turn?.id === messageId
    || message.replyAliasIds?.includes(messageId)
    || `transcript-message:${fallbackIndex}` === messageId;
}
