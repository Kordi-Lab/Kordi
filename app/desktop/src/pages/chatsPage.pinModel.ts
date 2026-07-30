import { collaborationMessageSourceId } from '@/features/collaboration/legacyBridgeCompatibility';
import type { Message } from '@/kordi-app/types';

export function chatMessageActionId(message: Message) {
  return (
    message.id?.trim()
    || message.entryId?.trim()
    || message.turn?.id?.trim()
    || ''
  );
}

export function stableCloudPinMessageId(
  message: Message,
  conversationId: string,
) {
  const actionId = chatMessageActionId(message);
  return collaborationMessageSourceId(actionId, conversationId) ?? actionId;
}

export function pinnedMessageCandidateIds(
  message: Message,
  conversationId: string,
) {
  return [
    ...new Set(
      [
        chatMessageActionId(message),
        stableCloudPinMessageId(message, conversationId),
      ]
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}
