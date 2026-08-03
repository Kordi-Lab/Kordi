import { useState } from 'react';
import { ChevronDown, ChevronUp, CornerDownLeft } from 'lucide-react';

import { replyStatusText } from '@/features/chat/replyAttribution';
import { navigateToTranscriptMessage } from '@/features/chat/transcriptNavigation';
import { cn } from '@/lib/utils';
import type { MessageReplySummary, MessageSourceReference } from '../types';

function sourceQuoteText(sourceMessage: MessageSourceReference) {
  return sourceMessage.text.trim();
}

function sourceQuoteNeedsFold(sourceMessage: MessageSourceReference) {
  const text = sourceQuoteText(sourceMessage);
  return text.split(/\r?\n/).length > 3 || text.replace(/\s+/g, ' ').length > 260;
}

export function SourceMessageQuote({
  sourceMessage,
  onNavigateToMessage,
  compactReplyPreview = false,
}: {
  sourceMessage?: MessageSourceReference | null;
  onNavigateToMessage?: (messageId: string, sourceMessage?: MessageSourceReference) => void;
  compactReplyPreview?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!sourceMessage) return null;
  const canFold = sourceQuoteNeedsFold(sourceMessage);
  const senderLabel = compactReplyPreview ? 'Replying to' : (sourceMessage.senderLabel?.trim() || 'message');
  const attachmentText = compactReplyPreview
    ? ''
    : (sourceMessage.attachmentCount ? ` · ${sourceMessage.attachmentCount} attachment${sourceMessage.attachmentCount === 1 ? '' : 's'}` : '');
  const navigate = () => {
    if (onNavigateToMessage) {
      onNavigateToMessage(sourceMessage.messageId, sourceMessage);
      return;
    }
    navigateToTranscriptMessage(sourceMessage.messageId);
  };

  return (
    <div className="app-source-message-quote w-full">
      <button
        type="button"
        className="app-source-message-quote-link grid max-w-full grid-cols-[minmax(0,1fr)] items-start text-left"
        onClick={navigate}
        title="Jump to original request"
      >
        <span className="min-w-0">
          <span className={cn('app-source-message-quote-text-frame', canFold && !expanded && 'app-source-message-quote-folded', 'block')}>
            <span className="app-source-message-quote-text block whitespace-pre-wrap text-[12px] leading-5">
              <span className="app-source-message-quote-label app-source-message-quote-inline-label font-medium">{senderLabel}{attachmentText}: </span>{sourceQuoteText(sourceMessage)}
            </span>
          </span>
        </span>
      </button>
      {canFold ? (
        <div className="app-fold-reveal-row app-source-message-quote-reveal-row">
          <button
            type="button"
            className="app-button-quiet app-inline-expand-toggle app-source-message-quote-toggle"
            onClick={() => setExpanded((current) => !current)}
            aria-expanded={expanded}
          >
            <span>{expanded ? 'Hide request' : 'Show full request'}</span>
            {expanded ? <ChevronUp className="app-inline-expand-toggle-icon" aria-hidden="true" /> : <ChevronDown className="app-inline-expand-toggle-icon" aria-hidden="true" />}
          </button>
          <span className="app-fold-reveal-line" aria-hidden="true" />
        </div>
      ) : null}
    </div>
  );
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
