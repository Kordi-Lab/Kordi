import type {
  AppendCanonicalMessageRequest,
  DesktopCollaborationState,
} from '@/kordi-app/types';
import { isRetryableCloudDeliveryError } from '@/features/cloud/cloudAuthError';

import {
  failedPreparedCanonicalUserMessage,
  markOptimisticCollaborationMessageFailed,
  type PreparedCanonicalUserMessage,
} from './optimistic';

export function createCloudCollaborationClientMessageId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (token) => {
    const random = Math.floor(Math.random() * 16);
    const value = token === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

export function collaborationSendFailureDetail(
  error: unknown,
  fallback = 'Unable to send collaboration message',
) {
  return error instanceof Error ? error.message : fallback;
}

export function shouldKeepCollaborationSendPending(error: unknown): boolean {
  return isRetryableCloudDeliveryError(error);
}

export function terminalCollaborationSendFailure({
  error,
  fallback,
  conversationId,
  messageId,
  markOptimisticFailure = true,
}: {
  error: unknown;
  fallback: string;
  conversationId: string;
  messageId: string;
  markOptimisticFailure?: boolean;
}): {
  detail: string;
  updateOptimisticState: (current: DesktopCollaborationState | null) => DesktopCollaborationState | null;
} | null {
  if (shouldKeepCollaborationSendPending(error)) return null;
  const detail = collaborationSendFailureDetail(error, fallback);
  return {
    detail,
    updateOptimisticState: (current) => (
      markOptimisticFailure
        ? markOptimisticCollaborationMessageFailed(current, conversationId, messageId, detail)
        : current
    ),
  };
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
