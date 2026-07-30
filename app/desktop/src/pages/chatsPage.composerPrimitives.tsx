import { Copy, FileText, Image as ImageIcon, Send, X } from 'lucide-react';

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
          className="rounded-full px-3 py-1.5 text-[12px] font-medium text-[color:var(--utility-muted-text)] transition hover:bg-[color:var(--app-control-hover)] hover:text-[color:var(--utility-foreground)]"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold text-[color:var(--utility-foreground)] transition hover:bg-[color:var(--app-control-hover)] disabled:cursor-not-allowed disabled:opacity-50"
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
      className="mb-1.5 flex items-start gap-2 rounded-[14px] border border-sky-300/20 bg-sky-400/10 px-2.5 py-2 text-left"
    >
      <span className="mt-0.5 h-8 w-0.5 shrink-0 rounded-full bg-sky-300" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] font-semibold text-sky-200">
          {quote.source.senderLabel}
        </div>
        <div className="truncate text-[11px] text-slate-300">
          {quote.source.textPreview
            || `${quote.source.attachmentCount} attachment${quote.source.attachmentCount === 1 ? '' : 's'}`}
        </div>
      </div>
      <button
        type="button"
        aria-label="Remove quoted message"
        onClick={onClear}
        className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-slate-400 transition hover:bg-white/10 hover:text-white"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

type ComposerAttachmentListProps = Pick<
  ChatsPageComposer,
  'chatComposerAttachments' | 'removeChatComposerAttachment'
>;

export function ComposerAttachmentList({
  chatComposerAttachments,
  removeChatComposerAttachment,
}: ComposerAttachmentListProps) {
  if (chatComposerAttachments.length === 0) return null;

  return (
    <div className="mb-1 flex flex-wrap items-center gap-1.5">
      {chatComposerAttachments.map((attachment) => (
        <div
          key={attachment.id}
          className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-[color:var(--app-divider)] bg-[color:var(--app-control-bg)] px-2.5 text-[11px] text-[color:var(--utility-foreground)]"
        >
          {attachment.kind === 'image' ? (
            <ImageIcon className="h-3.5 w-3.5 shrink-0 text-sky-300" />
          ) : (
            <FileText className="h-3.5 w-3.5 shrink-0 text-slate-300" />
          )}
          <span className="max-w-[220px] truncate leading-none">{attachment.name}</span>
          <button
            type="button"
            onClick={() => removeChatComposerAttachment(attachment.id)}
            className="text-[color:var(--utility-muted-text)] transition hover:text-[color:var(--utility-foreground)]"
            aria-label={`Remove ${attachment.name}`}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
