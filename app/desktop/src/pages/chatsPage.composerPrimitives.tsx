import { Copy, Pencil, Send, X } from 'lucide-react';

import { BlobEmojiInlineText } from '@/features/emoji/BlobEmojiInlineText';
import { useActiveLocalProfileIdentity } from '@/kordi-app/components/localProfileIdentity';
import { quotedSenderLabel } from '@/lib/identityLabels';
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
  const activeLocalProfileIdentity = useActiveLocalProfileIdentity();
  const senderLabel = quotedSenderLabel(quote.source.senderLabel, activeLocalProfileIdentity.displayName);
  const text = quote.source.textPreview
    || `[${quote.source.attachmentCount === 1 ? 'Attachment' : `${quote.source.attachmentCount} attachments`}]`;
  return (
    <div
      data-composer-quote-preview="true"
      className="mb-1.5 flex min-w-0 items-center gap-2 px-1 text-left"
    >
      <div
        className="min-w-0 flex-1 truncate border-l-2 border-[color:color-mix(in_oklab,var(--utility-muted-text)_28%,transparent)] py-px pl-2 text-[12px] leading-4 text-[color:color-mix(in_oklab,var(--utility-muted-text)_64%,transparent)]"
        title={`${senderLabel}: ${text}`}
      >
        <span>{senderLabel}: </span>
        <BlobEmojiInlineText text={text} />
      </div>
      <button
        type="button"
        aria-label="Remove quote"
        onClick={onClear}
        className="app-button-quiet grid h-6 w-6 shrink-0 place-items-center rounded-full p-0"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

export function ComposerEditPreview({
  text,
  onCancel,
}: {
  text: string;
  onCancel?: () => void;
}) {
  return (
    <div data-composer-edit-preview="true" className="mb-1 flex items-center gap-2 px-1 py-1 text-left">
      <Pencil className="h-4 w-4 shrink-0 text-[color:var(--app-sidebar-accent)]" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] font-semibold text-[color:var(--app-sidebar-accent)]">
          Edit message
        </div>
        <div className="truncate text-[11px] text-[color:var(--utility-muted-text)]"><BlobEmojiInlineText text={text} /></div>
      </div>
      <button
        type="button"
        aria-label="Cancel message edit"
        onClick={onCancel}
        className="app-button-quiet grid h-7 w-7 shrink-0 place-items-center rounded-[8px] p-0"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
