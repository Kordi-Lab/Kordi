import type { CloudMessage } from './authClient';
import type { CloudGroupControlEnvelope } from './cloudGroupMessages';

export function cloudGroupMessageIsUnreadForAccount(
  message: CloudMessage,
  envelope: CloudGroupControlEnvelope,
  accountId: string,
) {
  if (envelope.kind !== 'group-message' || !envelope.message) return false;
  if (
    envelope.message.senderKind === 'agent'
    && ['queued', 'processing'].includes(envelope.message.deliveryState?.trim() ?? '')
  ) return false;
  const selfAgentMessage = envelope.message.senderKind === 'agent'
    && envelope.message.senderAccountId === accountId;
  if (selfAgentMessage) return true;
  return message.toAccountId === accountId
    && message.direction === 'incoming'
    && !message.readAt
    && message.fromAccountId !== accountId
    && envelope.message.senderAccountId !== accountId;
}
