import type { CanonicalSessionState } from '@/kordi-app/types';

import type { AttachmentItem } from '../composerController.types';
import type { PreparedCanonicalUserMessage } from './optimistic';
import { optimisticAttachmentContent } from './optimisticAttachments';

function contentRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Replaces the attachment content of a prepared message, for example after its voice transcript is ready. */
export function preparedCanonicalUserMessageWithAttachments(
  prepared: PreparedCanonicalUserMessage | null,
  attachments: AttachmentItem[],
  contentText = prepared?.request.contentText ?? '',
): PreparedCanonicalUserMessage | null {
  if (!prepared) return prepared;
  return {
    ...prepared,
    request: {
      ...prepared.request,
      contentText,
      content: {
        ...contentRecord(prepared.request.content),
        ...optimisticAttachmentContent(attachments),
      },
    },
  };
}

/** Applies the new content to the displayed message without changing its delivery state. */
export function replaceOptimisticCanonicalMessageContent(
  current: CanonicalSessionState | null,
  prepared: PreparedCanonicalUserMessage | null,
): CanonicalSessionState | null {
  if (!current || !prepared) return current;
  let changed = false;
  const messages = current.messages.map((message) => {
    if (message.id !== prepared.messageId || message.sessionId !== prepared.request.sessionId) return message;
    changed = true;
    return {
      ...message,
      contentText: prepared.request.contentText,
      contentHash: null,
      content: {
        ...contentRecord(message.content),
        ...contentRecord(prepared.request.content),
        deliveryState: contentRecord(message.content).deliveryState,
      },
    };
  });
  return changed ? { ...current, messages } : current;
}
