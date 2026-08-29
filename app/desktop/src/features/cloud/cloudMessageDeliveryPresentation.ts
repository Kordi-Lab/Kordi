import type {
  Contact,
  DesktopCollaborationConversationMessage,
  MessageReadReceiptSummary,
} from '@/kordi-app/types';
import type { CloudMessage } from './authClient';

function directReadReceiptSummary(
  message: CloudMessage,
  contact: Contact | undefined,
): MessageReadReceiptSummary | null {
  const accountId = message.toAccountId.trim();
  const contactAccountId = contact?.sourceParticipantId?.trim()
    || contact?.sourceHumanId?.trim();
  const name = contact?.name.trim();
  if (
    !message.readAt
    || !contact
    || !accountId
    || accountId === message.fromAccountId.trim()
    || !contactAccountId
    || contactAccountId !== accountId
    || !name
  ) return null;
  return {
    count: 1,
    participants: [{
      id: `human:${accountId}`,
      name,
      avatarSeed: contact.avatarSeed ?? null,
      profileImageUrl: contact.profileImageUrl ?? null,
      readAt: message.readAt,
    }],
  };
}

export function cloudMessageDeliveryPresentation(
  message: CloudMessage,
  contact: Contact | undefined,
  agentDeliveryState: string | null | undefined,
  cancelled: boolean,
): Pick<DesktopCollaborationConversationMessage, 'deliveryState' | 'readReceiptSummary'> {
  const deliveryState = agentDeliveryState === 'failed'
    ? 'failed'
    : cancelled
      ? 'cancelled'
      : message.direction === 'outgoing'
        ? (message.readAt ? 'read' : 'delivered')
        : agentDeliveryState === 'complete'
          ? 'complete'
          : null;
  const readReceiptSummary = deliveryState === 'read'
    ? directReadReceiptSummary(message, contact)
    : null;
  return {
    deliveryState,
    ...(readReceiptSummary ? { readReceiptSummary } : {}),
  };
}
