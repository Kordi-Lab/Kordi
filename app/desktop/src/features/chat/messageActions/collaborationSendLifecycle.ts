import type { AppendCanonicalMessageRequest } from '@/kordi-app/types';

import {
  failedPreparedCanonicalUserMessage,
  type PreparedCanonicalUserMessage,
} from './optimistic';

export function collaborationSendFailureDetail(
  error: unknown,
  fallback = 'Unable to send collaboration message',
) {
  return error instanceof Error ? error.message : fallback;
}

export function shouldShowCollaborationSendFailureNotice(hasInlineFailureTarget: boolean) {
  return !hasInlineFailureTarget;
}

export function shouldAppendOptimisticCollaborationMessage(_conversationId: string): boolean {
  return true;
}

export function failedCanonicalGroupMessageRequest(
  prepared: PreparedCanonicalUserMessage | null,
  detail: string,
  recipientIds: readonly string[],
): AppendCanonicalMessageRequest | null {
  const failed = failedPreparedCanonicalUserMessage(prepared, detail);
  if (!failed) return null;
  const content = failed.request.content && typeof failed.request.content === 'object'
    ? failed.request.content
    : {};
  return {
    ...failed.request,
    content: {
      ...content,
      deliveryState: 'failed',
      deliveredRecipientIds: [],
      pendingRecipientIds: [],
      exhaustedRecipientIds: [...new Set(recipientIds.map((id) => id.trim()).filter(Boolean))],
    },
  };
}
