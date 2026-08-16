import type { Message } from '@/kordi-app/types';

export function transcriptMessageIsOwnHuman(message: Message): boolean {
  return (message.callActivity
    ? message.callActivity.direction === 'outgoing'
    : (message.isOwnMessage ?? (message.role === 'user')))
    && (message.senderType ?? 'human') === 'human';
}

export function transcriptMessageIsPeerHuman(message: Message, isOwnHumanMessage: boolean): boolean {
  return !isOwnHumanMessage
    && (Boolean(message.callActivity) || message.senderType === 'human' || message.role === 'person');
}
