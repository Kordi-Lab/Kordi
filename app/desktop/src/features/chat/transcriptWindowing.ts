import type { Message } from '@/kordi-app/types';
import { transcriptMessageNavigationIds } from './transcriptMessageIdentity';

export const TRANSCRIPT_WINDOW_OVERSCAN = 12;
export const TRANSCRIPT_WINDOW_ESTIMATED_MESSAGE_HEIGHT = 74;
export const TRANSCRIPT_HISTORY_PREFETCH_SCREENS = 2;

export function shouldPrefetchTranscriptHistory(scrollTop: number, viewportHeight: number) {
  return scrollTop <= Math.max(320, viewportHeight * TRANSCRIPT_HISTORY_PREFETCH_SCREENS);
}

export function transcriptWindowMessageIdentity(message: Message | undefined, fallbackIndex: number) {
  if (!message) return 'none';
  return message.clientMessageId
    ?? message.id
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
  return transcriptMessageNavigationIds(message).includes(messageId)
    || `transcript-message:${fallbackIndex}` === messageId;
}
