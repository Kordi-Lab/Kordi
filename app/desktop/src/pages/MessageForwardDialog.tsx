import { useEffect, useMemo, useState } from 'react';
import { Send, X } from 'lucide-react';

import type { ForwardDestination } from '@/features/chat/messageForwarding';
import type { MessageActionSource } from '@/features/chat/messageActionMetadata';

export type MessageForwardDialogProps = {
  sources: MessageActionSource[];
  destinations: ForwardDestination[];
  onClose: () => void;
  onForward: (destination: ForwardDestination, caption: string) => void;
};

function sourcePreview(source: MessageActionSource) {
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
  const previewSources = sources.slice(0, 3);
  const hiddenPreviewCount = Math.max(0, sources.length - previewSources.length);

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
      className="app-overlay fixed inset-0 z-[260] flex items-center justify-center bg-black/35 p-4 backdrop-blur-[10px]"
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
        className="app-message-forward-dialog w-full max-w-[380px] overflow-hidden rounded-[22px] border border-[color:var(--app-control-border)] bg-[color:var(--app-modal-bg)] text-[color:var(--utility-foreground)] shadow-[var(--app-shadow-float)] backdrop-blur-[var(--app-glass-blur-float)]"
      >
        <header className="flex items-start justify-between gap-3 border-b border-[color:var(--app-divider)] px-4 py-3">
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

        {isBatch ? (
          <div
            className="mx-3 mt-3 rounded-2xl border border-[color:var(--app-control-border)] bg-[color:var(--app-control-bg)] px-3 py-2"
            data-message-forward-selected-preview="true"
          >
            <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[color:var(--utility-muted-text)]">Selected preview</div>
            <div className="space-y-1">
              {previewSources.map((source) => (
                <div key={source.sourceMessageId} className="truncate text-[11px] text-[color:var(--utility-foreground)]">
                  {source.senderLabel}: {sourcePreview(source)}
                </div>
              ))}
              {hiddenPreviewCount > 0 ? (
                <div className="text-[11px] text-[color:var(--utility-muted-text)]">+{hiddenPreviewCount} more</div>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="max-h-[280px] overflow-y-auto px-2 py-2" data-message-forward-destinations="true">
          {destinations.length === 0 ? (
            <p className="px-2 py-5 text-center text-[12px] text-[color:var(--utility-muted-text)]">No chats available to forward to.</p>
          ) : destinations.map((destination) => {
            const selected = destination.id === selectedId;
            return (
              <button
                key={destination.id}
                type="button"
                className={`flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left transition ${selected ? 'bg-[color:var(--app-control-active)] text-[color:var(--utility-foreground)]' : 'text-[color:var(--utility-foreground)] hover:bg-[color:var(--app-control-hover)]'}`}
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

        <footer className="border-t border-[color:var(--app-divider)] p-3">
          {!isBatch ? (
            <textarea
              className="mb-3 min-h-[52px] w-full resize-none rounded-2xl border border-[color:var(--app-control-border)] bg-[color:var(--app-control-bg)] px-3 py-2 text-[12px] text-[color:var(--utility-foreground)] outline-none placeholder:text-[color:var(--utility-muted-text)] focus:border-[color:var(--app-sidebar-accent)]"
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
