import { Clock3, SquarePen, X } from 'lucide-react';

import {
  MessageBubbleShapeBackdrop,
  queuedMessageBubbleShapeClass,
} from '@/features/chat/messageBubbleShape';
import { MessageInlineContent } from '@/kordi-app/components/messageInlineContent';
import type { QueuedDesktopChatMessage } from '@/kordi-app/types';
import { cn } from '@/lib/utils';

export function QueuedMessageBubble({
  message,
  isCompressionActive,
  onEdit,
  onCancel,
}: {
  message: QueuedDesktopChatMessage;
  isCompressionActive: boolean;
  onEdit?: (sessionId: string, queuedMessageId: string) => void;
  onCancel?: (sessionId: string, queuedMessageId: string) => void;
}) {
  return (
    <div className="flex justify-end py-0.5">
      <div
        className={cn(
          'app-queued-message max-w-[min(72%,34rem)] px-3 py-2 text-right',
          queuedMessageBubbleShapeClass,
        )}
      >
        <MessageBubbleShapeBackdrop side="own" />
        <div className="min-w-0 text-left">
          <div className="mb-0.5 flex items-center justify-between gap-3">
            <div className="app-queued-message-label inline-flex min-w-0 items-center gap-1.5 text-[9.5px] font-semibold uppercase tracking-[0.07em]">
              <Clock3 className="h-2.5 w-2.5 shrink-0" />
              <span className="truncate">
                {isCompressionActive
                  ? 'Queued during compression'
                  : 'Queued next'}
              </span>
            </div>
            <div className="app-queued-message-meta shrink-0 text-[10px] leading-none">
              {message.time}
            </div>
          </div>
          <div className="mt-0.5 flex items-center gap-2">
            <div className="app-queued-message-text min-w-0 flex-1 whitespace-pre-wrap break-words text-[13px] leading-5" data-kordi-copy-surface="message">
              <MessageInlineContent text={message.text} />
            </div>
            <div
              className="app-queued-message-actions flex shrink-0 items-center gap-1 self-center"
              aria-label="Queued message actions"
            >
              <button
                type="button"
                className="app-button-quiet app-queued-message-edit inline-flex h-7 w-7 items-center justify-center rounded-full p-0"
                aria-label={`Edit queued message: ${message.text.slice(0, 48)}`}
                title="Edit queued message"
                onClick={() => onEdit?.(message.sessionId, message.id)}
              >
                <SquarePen className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <button
                type="button"
                className="app-button-quiet app-queued-message-cancel inline-flex h-7 w-7 items-center justify-center rounded-full p-0"
                aria-label={`Cancel queued message: ${message.text.slice(0, 48)}`}
                title="Cancel queued message"
                onClick={() => onCancel?.(message.sessionId, message.id)}
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
        {message.attachments.length > 0 ? (
          <div className="app-queued-message-meta mt-1 text-[10px] leading-none">
            {message.attachments.length} attachment
            {message.attachments.length === 1 ? '' : 's'} waiting
          </div>
        ) : null}
      </div>
    </div>
  );
}
