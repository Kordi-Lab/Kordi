import { Clock3, SquarePen, X } from 'lucide-react';

import {
  MessageBubbleShapeBackdrop,
  queuedMessageBubbleShapeClass,
  humanMessageBubbleShapeClass,
} from '@/features/chat/messageBubbleShape';
import { IdentityAvatar, useLocalProfileAvatarSeed } from '@/kordi-app/components/IdentityAvatar';
import type { TranscriptDensityMode } from '@/kordi-app/components/transcript';
import { MessageInlineContent } from '@/kordi-app/components/messageInlineContent';
import { MessageHoverTime } from '@/kordi-app/components/transcriptMessageTime';
import type { QueuedDesktopChatMessage } from '@/kordi-app/types';
import { generatedAvatarSeedForLabel, selfDisplayName } from '@/lib/identityLabels';
import { cn } from '@/lib/utils';

const queuedActionButtonClass = 'app-button-quiet app-queued-message-action inline-flex h-5 w-5 items-center justify-center rounded-full p-0';

export function QueuedMessageBubble({
  message,
  isCompressionActive,
  onEdit,
  onCancel,
  own = true,
  sender,
  threadLayout = false,
  densityMode,
  showAvatar = true,
  avatarImageUrl,
}: {
  message: Pick<QueuedDesktopChatMessage, 'id' | 'sessionId' | 'text' | 'time'> & { attachments: readonly unknown[] };
  isCompressionActive: boolean;
  onEdit?: (sessionId: string, queuedMessageId: string) => void;
  onCancel?: (sessionId: string, queuedMessageId: string) => void;
  own?: boolean;
  sender?: string;
  threadLayout?: boolean;
  densityMode?: TranscriptDensityMode;
  showAvatar?: boolean;
  avatarImageUrl?: string | null;
}) {
  const profileAvatarSeed = useLocalProfileAvatarSeed();
  const statusLabel = isCompressionActive ? 'Queued during compression' : 'Queued';
  const actionButtonClass = cn(queuedActionButtonClass, threadLayout && '-my-1');
  const actions = onEdit || onCancel ? (
    <span className="app-queued-message-actions inline-flex shrink-0 items-center" role="group" aria-label="Queued message actions">
      {onEdit ? <button
        type="button"
        className={cn(actionButtonClass, 'app-queued-message-edit')}
        aria-label={`Edit queued message: ${message.text.slice(0, 48)}`}
        title="Edit queued message"
        onClick={() => onEdit?.(message.sessionId, message.id)}
      >
        <SquarePen className="h-3 w-3" aria-hidden="true" />
      </button> : null}
      {onCancel ? <button
        type="button"
        className={cn(actionButtonClass, 'app-queued-message-cancel')}
        aria-label={`Cancel queued message: ${message.text.slice(0, 48)}`}
        title="Cancel queued message"
        onClick={() => onCancel?.(message.sessionId, message.id)}
      >
        <X className="h-3 w-3" aria-hidden="true" />
      </button> : null}
    </span>
  ) : null;
  const attachmentsLine = message.attachments.length > 0 ? (
    <div className="app-message-footer app-queued-message-attachments mt-1 text-[10px] leading-none">
      {message.attachments.length} attachment{message.attachments.length === 1 ? '' : 's'} waiting
    </div>
  ) : null;
  if (threadLayout) {
    const name = selfDisplayName(sender ?? 'Me', own);
    return (
      <div className="app-queued-message-thread flex w-full flex-col gap-1 app-thread-message-row pt-0.5 pb-0.5" data-message-layout="threads">
        <div className="flex w-full max-w-full app-thread-message-main items-start gap-2">
          <IdentityAvatar
            kind="human"
            seed={own ? profileAvatarSeed : generatedAvatarSeedForLabel('human', name)}
            isSelf={own}
            name={name}
            imageUrl={avatarImageUrl ?? undefined}
            className="h-7 w-7 mb-0.5 border border-white/10"
          />
          <div className="min-w-0 flex-1">
            <div className="app-thread-message-header">
              <span className="app-thread-message-author">{name}</span>
              <span className="app-thread-message-queued">
                <Clock3 className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
                <span>{statusLabel}</span>
              </span>
              <time className="app-thread-message-time">{message.time}</time>
              {actions}
            </div>
            <div className="app-queued-message-text min-w-0 whitespace-pre-wrap break-words text-[14px] leading-5" data-kordi-copy-surface="message">
              <MessageInlineContent text={message.text} />
            </div>
            {attachmentsLine}
          </div>
        </div>
      </div>
    );
  }
  // Single-line text keeps the status inline after the text, like a sent message's receipt.
  const inline = !/\r?\n/.test(message.text) && message.attachments.length === 0;
  const meta = (
    <span
      className={cn(
        'app-message-footer app-queued-message-meta items-center gap-1 whitespace-nowrap text-[10px] leading-none',
        inline ? 'ml-3 inline-flex translate-y-[1px]' : 'mt-1.5 flex justify-end',
      )}
    >
      <Clock3 className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
      <span className="app-queued-message-label">{statusLabel}</span>
    </span>
  );
  const text = (
    <span className="app-queued-message-text whitespace-pre-wrap break-words" data-kordi-copy-surface="message">
      <MessageInlineContent text={message.text} />
    </span>
  );
  const compact = Boolean(densityMode && densityMode !== 'default');
  const avatarSizeClass = compact ? 'h-7 w-7' : 'h-8 w-8';
  const name = selfDisplayName(sender ?? 'Me', own);
  return (
    <div className={cn('flex w-full flex-col pt-0.5 pb-0.5', own ? 'items-end' : 'items-start')}>
      <div className={cn('app-queued-message-row flex w-full max-w-full items-end', compact ? 'gap-1.5' : 'gap-2', own ? 'flex-row-reverse' : 'flex-row')}>
        {showAvatar ? (
          <IdentityAvatar
            kind="human"
            seed={own ? profileAvatarSeed : generatedAvatarSeedForLabel('human', name)}
            isSelf={own}
            name={name}
            imageUrl={avatarImageUrl ?? undefined}
            className={cn('mb-0.5 border border-white/10', avatarSizeClass)}
          />
        ) : (
          <span className={cn('app-message-avatar-spacer shrink-0', avatarSizeClass)} aria-hidden="true" />
        )}
        <div
          className={cn(
            'app-queued-message app-message-hover-time-trigger w-fit min-w-0 max-w-[52rem] text-[14px]',
            compact ? 'app-message-bubble-contact-compact rounded-[8px] px-3 py-1.5' : 'px-4 py-2.5',
            own
              ? cn(queuedMessageBubbleShapeClass, 'app-chat-bubble-user')
              : cn(humanMessageBubbleShapeClass('peer'), 'app-message-bubble-queued app-chat-bubble-peer'),
          )}
          data-queued-message="true"
        >
          <MessageBubbleShapeBackdrop side={own ? 'own' : 'peer'} tail={false} />
          {sender ? <div className="app-message-inline-sender mb-1 truncate text-[12px] font-semibold leading-4">{sender}</div> : null}
          {inline ? (
            <div className="leading-[1.45]">{text}{meta}</div>
          ) : (
            <>
              <div className="leading-[1.45]">{text}</div>
              {attachmentsLine}
              {meta}
            </>
          )}
        </div>
        {actions ? <span className="flex shrink-0 self-end">{actions}</span> : null}
        <MessageHoverTime msg={{ role: own ? 'user' : 'person', sender: sender ?? 'Me', text: message.text, time: message.time }} side={own ? 'own' : 'peer'} />
      </div>
    </div>
  );
}
