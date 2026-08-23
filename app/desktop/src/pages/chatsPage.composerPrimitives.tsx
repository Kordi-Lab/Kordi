import { Copy, Send, X } from 'lucide-react';

import type { ChatsPageComposer } from '@/pages/chatsPage.types';

type MessageSelectionBarProps = {
  count: number;
  onCancel?: () => void;
  onCopy?: () => void;
  onForward?: () => void;
};

export function MessageSelectionBar({
  count,
  onCancel,
  onCopy,
  onForward,
}: MessageSelectionBarProps) {
  return (
    <div
      data-message-selection-bar="true"
      className="app-message-selection-bar mb-2 flex items-center justify-between gap-3 rounded-[22px] border border-[color:var(--app-control-border)] bg-[color:var(--app-modal-bg)] px-3.5 py-2.5 text-[color:var(--utility-foreground)] shadow-[var(--app-shadow-float)] backdrop-blur-[var(--app-glass-blur-float)]"
    >
      <div className="text-[12px] font-semibold tabular-nums">{count} selected</div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="app-button-quiet rounded-full px-3 py-1.5 text-[12px] font-medium"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="app-button-quiet inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold"
          onClick={onCopy}
          disabled={!onCopy || count <= 0}
        >
          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
          Copy
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-full bg-[color:var(--app-sidebar-accent)] px-3 py-1.5 text-[12px] font-semibold text-[color:var(--app-sidebar-accent-text)] transition disabled:cursor-not-allowed disabled:opacity-50"
          onClick={onForward}
          disabled={!onForward || count <= 0}
        >
          <Send className="h-3.5 w-3.5" aria-hidden="true" />
          Forward
        </button>
      </div>
    </div>
  );
}

type ComposerQuotePreviewProps = {
  quote: NonNullable<ChatsPageComposer['activeChatQuote']>;
  onClear?: () => void;
};

export function ComposerQuotePreview({
  quote,
  onClear,
}: ComposerQuotePreviewProps) {
  return (
    <div
      data-composer-quote-preview="true"
      className="mb-1 flex items-center gap-2 px-1 py-1 text-left"
    >
      <span className="h-8 w-px shrink-0 bg-[color:var(--app-sidebar-accent)]" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] font-semibold text-[color:var(--app-sidebar-accent)]">
          {quote.source.senderLabel}
        </div>
        <div className="truncate text-[11px] text-[color:var(--utility-muted-text)]">
          {quote.source.textPreview
            || `${quote.source.attachmentCount} attachment${quote.source.attachmentCount === 1 ? '' : 's'}`}
        </div>
      </div>
      <button
        type="button"
        aria-label="Remove quoted message"
        onClick={onClear}
        className="app-button-quiet grid h-7 w-7 shrink-0 place-items-center rounded-[8px] p-0"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
