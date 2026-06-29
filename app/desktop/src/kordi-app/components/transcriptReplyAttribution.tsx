import { useState, type RefObject } from 'react';
import { ChevronDown, ChevronUp, CornerDownLeft } from 'lucide-react';

import { replyStatusText } from '@/features/chat/replyAttribution';
import { cn } from '@/lib/utils';
import type { MessageReplySummary, MessageSourceReference } from '../types';

export function transcriptMessageDomId(messageId: string) {
  return `app-transcript-message-${messageId.replace(/[^a-zA-Z0-9_-]+/g, '-')}`;
}

function scrollTranscriptElementIntoContainer(target: Element, scrollContainer?: HTMLElement | null) {
  if (!scrollContainer || !scrollContainer.contains(target)) return false;
  if (typeof target.getBoundingClientRect !== 'function' || typeof scrollContainer.getBoundingClientRect !== 'function') return false;

  const targetRect = target.getBoundingClientRect();
  const containerRect = scrollContainer.getBoundingClientRect();
  const nextTop = scrollContainer.scrollTop
    + (targetRect.top - containerRect.top)
    - (scrollContainer.clientHeight / 2)
    + (targetRect.height / 2);

  if (typeof scrollContainer.scrollTo === 'function') {
    scrollContainer.scrollTo({ top: Math.max(0, nextTop), behavior: 'smooth' });
  } else {
    scrollContainer.scrollTop = Math.max(0, nextTop);
  }
  return true;
}

export function navigateToTranscriptMessage(messageId: string, scrollRef?: RefObject<HTMLElement | null> | null) {
  if (typeof document === 'undefined') return false;
  const target = document.getElementById(transcriptMessageDomId(messageId));
  if (!target) return false;
  const visibleTarget = target.closest?.('[data-transcript-message-root]') ?? target;
  const discoveredScrollContainer = visibleTarget.closest?.('.app-scroll-area') as HTMLElement | null | undefined;
  if (!scrollTranscriptElementIntoContainer(visibleTarget, scrollRef?.current ?? discoveredScrollContainer ?? null)) {
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
  onNavigateToMessage?: (messageId: string, sourceMessage?: MessageSourceReference) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!sourceMessage) return null;
  const canFold = sourceQuoteNeedsFold(sourceMessage);
  const senderLabel = sourceMessage.senderLabel?.trim() || 'message';
  const attachmentText = sourceMessage.attachmentCount ? ` · ${sourceMessage.attachmentCount} attachment${sourceMessage.attachmentCount === 1 ? '' : 's'}` : '';
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
        className="app-source-message-quote-link grid max-w-full grid-cols-[3px_minmax(0,1fr)] items-start gap-2.5 text-left"
        onClick={navigate}
        title="Jump to original request"
      >
        <span className="app-source-message-quote-rail" aria-hidden="true" />
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
            className="app-inline-expand-toggle app-source-message-quote-toggle"
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
