/** Drops a trailing "Try again." when the error line already offers that action. */
export function withoutTryAgain(message: string): string {
  return message.replace(/\s*Try again\.?\s*$/i, '').trim() || message;
}
