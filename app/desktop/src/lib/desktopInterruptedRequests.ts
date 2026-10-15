import { invokeDesktop } from '@/lib/desktop';

/**
 * Closes a local session's request that an earlier app process admitted and
 * never answered. Resolves true when the interruption note was added; a turn
 * of this process is never touched.
 */
export function closeDesktopChatInterruptedRequest(sessionId: string) {
  return invokeDesktop<boolean>('desktop_chat_close_interrupted_request', { sessionId });
}
