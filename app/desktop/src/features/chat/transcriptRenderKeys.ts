import type { Message } from '@/kordi-app/types';

export function transcriptMessageRenderKey(message: Message, index: number) {
  if (message.id?.trim()) return `message:${message.id}`;
  return [
    'message:fallback',
    index,
    message.role,
    message.sender ?? '',
    message.senderType ?? '',
    message.isOwnMessage ? 'own' : 'peer',
  ].join(':');
}
