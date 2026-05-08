import { useState, type RefObject } from 'react';
import { CornerDownLeft } from 'lucide-react';

import { replyStatusText } from '@/features/chat/replyAttribution';
import { cn } from '@/lib/utils';
import type { MessageReplySummary, MessageSourceReference } from '../types';

export function transcriptMessageDomId(messageId: string) {
  return `app-transcript-message-${messageId.replace(/[^a-zA-Z0-9_-]+/g, '-')}`;
}

function scrollElementWithinContainer(target: Element, scrollContainer: HTMLElement) {
  if (typeof target.getBoundingClientRect !== 'function' || typeof scrollContainer.getBoundingClientRect !== 'function') {
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return;
  }
  const targetRect = target.getBoundingClientRect();
  const containerRect = scrollContainer.getBoundingClientRect();
  const targetTopWithinContainer = targetRect.top - containerRect.top + scrollContainer.scrollTop;
  const centeredTop = targetTopWithinContainer - ((scrollContainer.clientHeight - targetRect.height) / 2);
  const maxTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
  const top = Math.min(Math.max(0, centeredTop), maxTop);

  if (typeof scrollContainer.scrollTo === 'function') {
    scrollContainer.scrollTo({ top, behavior: 'smooth' });
  } else {
    scrollContainer.scrollTop = top;
  }
}

export function navigateToTranscriptMessage(
  messageId: string,
  scrollRef?: RefObject<HTMLElement | null> | null,
) {
  if (typeof document === 'undefined') return false;
  const target = document.getElementById(transcriptMessageDomId(messageId));
  if (!target) return false;
  const visibleTarget = target.closest?.('[data-transcript-message-root]') ?? target;
  const scrollContainer = scrollRef?.current;
  if (scrollContainer) {
    scrollElementWithinContainer(visibleTarget, scrollContainer);
  } else {
    visibleTarget.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  visibleTarget.classList.add('app-transcript-message-highlight');
  window.setTimeout(() => visibleTarget.classList.remove('app-transcript-message-highlight'), 1500);
  return true;
}

export function scrollTranscriptToBottom(scrollRef?: RefObject<HTMLElement | null> | null) {
  const scrollContainer = scrollRef?.current;
  if (!scrollContainer) return false;
  if (typeof scrollContainer.scrollTo === 'function') {
    scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: 'smooth' });
  } else {
    scrollContainer.scrollTop = scrollContainer.scrollHeight;
  }
  return true;
}

export function navigateToTranscriptMessageOrScrollBottom(
  messageId: string,
  scrollRef?: RefObject<HTMLElement | null> | null,
) {
  return navigateToTranscriptMessage(messageId, scrollRef) || scrollTranscriptToBottom(scrollRef);
}

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
}: {
  sourceMessage?: MessageSourceReference | null;
  onNavigateToMessage?: (messageId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!sourceMessage) return null;
  const canFold = sourceQuoteNeedsFold(sourceMessage);
  const senderLabel = sourceMessage.senderLabel?.trim() || 'message';
  const attachmentText = sourceMessage.attachmentCount ? ` · ${sourceMessage.attachmentCount} attachment${sourceMessage.attachmentCount === 1 ? '' : 's'}` : '';
  const navigate = () => {
    if (onNavigateToMessage) {
      onNavigateToMessage(sourceMessage.messageId);
      return;
    }
    navigateToTranscriptMessage(sourceMessage.messageId);
  };

  return (
    <div className="app-source-message-quote w-full">
      <button
        type="button"
        className="app-source-message-quote-link grid max-w-full grid-cols-[3px_minmax(0,1fr)_auto] items-start gap-2.5 text-left"
        onClick={navigate}
        title="Jump to original request"
      >
        <span className="app-source-message-quote-rail" aria-hidden="true" />
        <span className="min-w-0">
          <span className="app-source-message-quote-label block truncate text-[11px] font-medium">{senderLabel}{attachmentText}</span>
          <span className={cn('app-source-message-quote-text-frame', canFold && !expanded && 'app-source-message-quote-folded', 'block')}>
            <span className="app-source-message-quote-text block whitespace-pre-wrap text-[12px] leading-5">
              {sourceQuoteText(sourceMessage)}
            </span>
          </span>
        </span>
        <CornerDownLeft className="app-source-message-quote-icon mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      </button>
      {canFold ? (
        <button
          type="button"
          className={cn(
            'app-inline-expand-toggle app-source-message-quote-toggle',
            !expanded && 'app-source-message-quote-toggle-overlay',
            'flex w-fit items-center px-2 text-[9px] font-medium',
            expanded && 'mx-auto mt-1',
          )}
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
        >
          {expanded ? '— Click to hide request —' : '— Click to show full request —'}
        </button>
      ) : null}
    </div>
  );
}

export function RequestReplyLine({
  summary,
  own,
  onNavigateToMessage,
}: {
  summary?: MessageReplySummary;
  own: boolean;
  onNavigateToMessage?: (messageId: string) => void;
}) {
  const text = replyStatusText(summary);
  if (!summary || !text) return null;
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
        'app-message-reply-line flex w-fit items-center gap-1.5 px-1 text-[10px] font-medium leading-4 transition',
        own ? 'self-end text-slate-500 hover:text-slate-300' : 'self-start text-slate-500 hover:text-slate-300',
        !targetMessageId && 'cursor-default hover:text-slate-500',
      )}
      aria-label={targetMessageId ? `${text}; jump to latest reply` : text}
    >
      <span>{text}</span>
      <CornerDownLeft className="app-message-reply-line-icon h-3 w-3 shrink-0" aria-hidden="true" />
    </button>
  );
}
