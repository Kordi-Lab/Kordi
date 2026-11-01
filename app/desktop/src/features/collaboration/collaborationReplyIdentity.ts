import type { DesktopCollaborationConversation } from '@/kordi-app/types';
import { COLLABORATION_MESSAGE_DIRECTION_INBOUND, COLLABORATION_MESSAGE_DIRECTION_OUTBOUND } from './messages';

/** Preserve the reply slot across optimistic, runtime, and stored message IDs. */
export function collaborationReplyIdentity(conversation: DesktopCollaborationConversation) {
  const requestMessageIdByRequestId = new Map<string, string>();
  const replyIdentityByRequestId = new Map<string, string>();
  for (const message of conversation.messages) {
    const requestId = message.requestId?.trim();
    if (!requestId) continue;
    if (message.direction !== COLLABORATION_MESSAGE_DIRECTION_OUTBOUND && message.direction !== COLLABORATION_MESSAGE_DIRECTION_INBOUND) continue;
    const { id, clientMessageId } = message;
    const identity = clientMessageId?.trim() || id;
    for (const alias of [requestId, id, clientMessageId]) {
      if (alias) replyIdentityByRequestId.set(alias, identity);
    }
    if (!requestMessageIdByRequestId.has(requestId)) {
      requestMessageIdByRequestId.set(requestId, `collaboration-message:${conversation.id}:${id}`);
    }
  }

  const replyRenderKey = (requestId: string | null | undefined, local: boolean) => requestId
    ? `collaboration-reply:${conversation.id}:${local ? 'local' : 'remote'}:${replyIdentityByRequestId.get(requestId) ?? requestId}`
    : undefined;

  return { requestMessageIdByRequestId, replyRenderKey };
}
