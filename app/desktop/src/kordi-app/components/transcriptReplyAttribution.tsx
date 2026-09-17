import { CornerDownLeft, MessagesSquare } from 'lucide-react';

import { replyStatusText } from '@/features/chat/replyAttribution';
import { navigateToTranscriptMessage } from '@/features/chat/transcriptNavigation';
import { quotedSenderLabel } from '@/lib/identityLabels';
import { cn } from '@/lib/utils';
import type { MessageReplySummary, MessageSourceReference } from '../types';
import { useActiveLocalProfileIdentity } from './localProfileIdentity';
import { MessageInlineContent } from './messageInlineContent';

export type SourceMessageQuoteSide = 'own' | 'peer' | 'agent';

function sourceQuoteText(sourceMessage: MessageSourceReference) {
  const text = sourceMessage.text.replace(/\s+/g, ' ').trim();
  if (text) return text;
  const count = Math.max(0, Math.floor(sourceMessage.attachmentCount ?? 0));
  if (count <= 0) return '';
  return count === 1 ? '[Attachment]' : `[${count} attachments]`;
}

/** One quiet line under a message that names the quoted message and jumps back to it. */
export function SourceMessageQuote({
  sourceMessage,
  side = 'peer',
  onNavigateToMessage,
}: {
  sourceMessage?: MessageSourceReference | null;
  side?: SourceMessageQuoteSide;
  onNavigateToMessage?: (messageId: string, sourceMessage?: MessageSourceReference) => void;
}) {
  const activeLocalProfileIdentity = useActiveLocalProfileIdentity();
  if (!sourceMessage) return null;
  const senderLabel = quotedSenderLabel(sourceMessage.senderLabel, activeLocalProfileIdentity.displayName);
  const text = sourceQuoteText(sourceMessage);
  const navigate = () => {
    if (onNavigateToMessage) {
      onNavigateToMessage(sourceMessage.messageId, sourceMessage);
      return;
    }
    navigateToTranscriptMessage(sourceMessage.messageId);
  };

  return (
    <button
      type="button"
      className="app-source-message-quote"
      data-quote-side={side}
      onClick={navigate}
      title={text ? `${senderLabel}: ${text}` : senderLabel}
    >
      <span className="app-source-message-quote-text" data-kordi-copy-surface="message">
        <span className="app-source-message-quote-label">{senderLabel}: </span>
        <MessageInlineContent text={text} mentions={sourceMessage.mentions} linksInteractive={false} showSiteIcons={false} />
      </span>
    </button>
  );
}

/** Places the quote line under a message, aligned with the bubble's outer edge. */
export function SourceMessageQuoteRow({ className, ...quote }: Parameters<typeof SourceMessageQuote>[0] & { className?: string }) {
  return <div className={cn('flex min-w-0 max-w-full', className)}><SourceMessageQuote {...quote} /></div>;
}

export function RequestReplyLine({
  summary,
  own,
  inline = false,
  onNavigateToMessage,
}: {
  summary?: MessageReplySummary;
  own: boolean;
  inline?: boolean;
  onNavigateToMessage?: (messageId: string) => void;
}) {
  const text = replyStatusText(summary);
  const count = Math.max(0, summary?.replyCount ?? 0);
  const visibleCount = count > 0 ? String(count) : summary?.pending ? '…' : '';
  if (!summary || !text || !visibleCount) return null;
  const targetMessageId = summary.targetMessageId?.trim();
  const navigate = () => {
    if (!targetMessageId) return;
    if (onNavigateToMessage) {
      onNavigateToMessage(targetMessageId);
      return;
    }
    navigateToTranscriptMessage(targetMessageId);
  };

  return (
    <button
      type="button"
      onClick={navigate}
      disabled={!targetMessageId}
      className={cn(
        'app-message-reply-line inline-flex w-fit items-center gap-[3px] px-0 text-[9.5px] font-medium leading-none transition',
        inline ? 'align-baseline' : 'mt-0.5',
        own ? 'self-end text-slate-500 hover:text-slate-300' : 'self-start text-slate-500 hover:text-slate-300',
        !targetMessageId && 'cursor-default hover:text-slate-500',
      )}
      aria-label={targetMessageId ? `${text}; jump to latest reply` : text}
      title={targetMessageId ? text : undefined}
    >
      <CornerDownLeft className="app-message-reply-line-icon h-2.5 w-2.5 shrink-0" aria-hidden="true" />
      <span className="app-message-reply-count">{visibleCount}</span>
    </button>
  );
}

export function ThreadReplyLine({
  count,
  unread = false,
  own,
  inline = false,
  onOpen,
}: {
  count?: number;
  unread?: boolean;
  own: boolean;
  inline?: boolean;
  onOpen?: () => void;
}) {
  const visibleCount = Math.max(0, Math.floor(count ?? 0));
  if (visibleCount <= 0) return null;
  const label = `Discussion · ${visibleCount}`;
  const messageLabel = `${visibleCount} message${visibleCount === 1 ? '' : 's'}`;
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!onOpen}
      className={cn(
        'app-message-reply-line inline-flex w-fit items-center gap-[3px] px-0 text-[9.5px] font-medium leading-none transition',
        inline ? 'align-baseline' : 'mt-0.5',
        own ? 'self-end' : 'self-start',
      )}
      aria-label={`Open discussion with ${messageLabel}${unread ? ', unread messages' : ''}`}
    >
      <MessagesSquare className="app-message-reply-line-icon h-2.5 w-2.5 shrink-0" aria-hidden="true" />
      <span className="app-message-reply-count">{label}</span>
      {unread ? <span data-thread-unread="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--app-sidebar-accent)]" aria-hidden="true" /> : null}
    </button>
  );
}
