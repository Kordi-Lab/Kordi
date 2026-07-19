import { useEffect, useMemo, useState } from 'react';
import { Send, X } from 'lucide-react';

import type { ForwardDestination } from '@/features/chat/messageForwarding';
import type { ForwardMessageSource } from '@/features/chat/messageActionMetadata';

export type MessageForwardDialogProps = {
  sources: ForwardMessageSource[];
  destinations: ForwardDestination[];
  onClose: () => void;
  onForward: (destination: ForwardDestination, caption: string) => void;
};

function sourcePreview(source: ForwardMessageSource) {
  return source.textPreview || `${source.attachmentCount} attachment${source.attachmentCount === 1 ? '' : 's'}`;
}

export function MessageForwardDialog({
  sources,
  destinations,
  onClose,
  onForward,
}: MessageForwardDialogProps) {
  const [selectedId, setSelectedId] = useState(destinations[0]?.id ?? '');
  const [caption, setCaption] = useState('');
  const selectedDestination = useMemo(
    () => destinations.find((destination) => destination.id === selectedId) ?? null,
    [destinations, selectedId],
  );
  const primarySource = sources[0] ?? null;
  const isBatch = sources.length > 1;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Enter' && !event.shiftKey && selectedDestination) {
        event.preventDefault();
        onForward(selectedDestination, isBatch ? '' : caption);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [caption, isBatch, onClose, onForward, selectedDestination]);

  return (
    <div
      className="app-transient-overlay app-overlay fixed inset-0 z-[260] flex items-center justify-center p-4 backdrop-blur-[10px]"
      style={{ WebkitAppRegion: 'no-drag' as const }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="message-forward-dialog-title"
        data-message-forward-dialog="true"
        data-message-forward-mode={isBatch ? 'batch' : 'single'}
        className="app-transient-surface app-message-forward-dialog w-full max-w-[380px] overflow-hidden rounded-[20px] border"
      >
        <header className="app-transient-divider flex items-start justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 id="message-forward-dialog-title" className="text-[13px] font-semibold text-[color:var(--utility-foreground)]">
              {isBatch ? `Forward ${sources.length} messages` : 'Forward message'}
            </h2>
            {!isBatch && primarySource ? (
              <p className="mt-1 max-w-[290px] truncate text-[11px] text-[color:var(--utility-muted-text)]">
                {primarySource.senderLabel}: {sourcePreview(primarySource)}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            className="grid h-7 w-7 place-items-center rounded-full text-[color:var(--utility-muted-text)] transition hover:bg-[color:var(--app-control-hover)] hover:text-[color:var(--utility-foreground)]"
            onClick={onClose}
            aria-label="Close forward dialog"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </header>

        <div className="max-h-[280px] overflow-y-auto px-2 py-2" data-message-forward-destinations="true">
          {destinations.length === 0 ? (
            <p className="px-2 py-5 text-center text-[12px] text-[color:var(--utility-muted-text)]">No chats available to forward to.</p>
          ) : destinations.map((destination) => {
            const selected = destination.id === selectedId;
            return (
              <button
                key={destination.id}
                type="button"
                className={`app-transient-row flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left transition ${selected ? 'app-transient-row-selected' : ''}`}
                data-message-forward-destination={destination.id}
                aria-pressed={selected}
                onClick={() => setSelectedId(destination.id)}
              >
                <span className="min-w-0">
                  <span className="block truncate text-[12px] font-medium">{destination.label}</span>
                  {destination.subtitle ? <span className="block truncate text-[10px] text-[color:var(--utility-muted-text)]">{destination.subtitle}</span> : null}
                </span>
                {selected ? <span className="h-2 w-2 rounded-full bg-[color:var(--app-sidebar-accent)]" aria-hidden="true" /> : null}
              </button>
            );
          })}
        </div>

        <footer className="app-transient-divider border-t p-3">
          {!isBatch ? (
            <textarea
              className="mb-3 min-h-[52px] w-full resize-none rounded-[14px] border border-[color:var(--app-transient-border)] bg-[color:var(--app-transient-raised-bg)] px-3 py-2 text-[12px] text-[color:var(--app-transient-text)] outline-none placeholder:text-[color:var(--app-transient-muted-text)]"
              placeholder="Add a comment…"
              value={caption}
              onChange={(event) => setCaption(event.target.value)}
            />
          ) : null}
          <div className="flex justify-end gap-2">
            <button type="button" className="rounded-full px-3 py-1.5 text-[12px] text-[color:var(--utility-muted-text)] transition hover:bg-[color:var(--app-control-hover)] hover:text-[color:var(--utility-foreground)]" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-full bg-[color:var(--app-sidebar-accent)] px-3 py-1.5 text-[12px] font-semibold text-[color:var(--app-sidebar-accent-text)] transition disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!selectedDestination || sources.length === 0}
              onClick={() => {
                if (selectedDestination) onForward(selectedDestination, isBatch ? '' : caption);
              }}
            >
              <Send className="h-3.5 w-3.5" aria-hidden="true" />
              Forward
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
