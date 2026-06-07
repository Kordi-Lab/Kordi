import { useEffect, useMemo, useState } from 'react';
import { Send, X } from 'lucide-react';

import type { ForwardDestination } from '@/features/chat/messageForwarding';
import type { MessageActionSource } from '@/features/chat/messageActionMetadata';

export type MessageForwardDialogProps = {
  source: MessageActionSource;
  destinations: ForwardDestination[];
  onClose: () => void;
  onForward: (destination: ForwardDestination, caption: string) => void;
};

export function MessageForwardDialog({
  source,
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

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Enter' && !event.shiftKey && selectedDestination) {
        event.preventDefault();
        onForward(selectedDestination, caption);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [caption, onClose, onForward, selectedDestination]);

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
        className="w-full max-w-[360px] overflow-hidden rounded-[22px] border border-white/12 bg-[#101820]/95 shadow-2xl shadow-black/40"
      >
        <header className="flex items-start justify-between gap-3 border-b border-white/10 px-4 py-3">
          <div>
            <h2 id="message-forward-dialog-title" className="text-[13px] font-semibold text-slate-50">Forward message</h2>
            <p className="mt-1 max-w-[270px] truncate text-[11px] text-slate-400">
              {source.senderLabel}: {source.textPreview || `${source.attachmentCount} attachment${source.attachmentCount === 1 ? '' : 's'}`}
            </p>
          </div>
          <button
            type="button"
            className="grid h-7 w-7 place-items-center rounded-full text-slate-400 transition hover:bg-white/10 hover:text-white"
            onClick={onClose}
            aria-label="Close forward dialog"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </header>

        <div className="max-h-[280px] overflow-y-auto px-2 py-2" data-message-forward-destinations="true">
          {destinations.length === 0 ? (
            <p className="px-2 py-5 text-center text-[12px] text-slate-400">No chats available to forward to.</p>
          ) : destinations.map((destination) => {
            const selected = destination.id === selectedId;
            return (
              <button
                key={destination.id}
                type="button"
                className={`flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left transition ${selected ? 'bg-sky-500/18 text-slate-50' : 'text-slate-200 hover:bg-white/8'}`}
                data-message-forward-destination={destination.id}
                aria-pressed={selected}
                onClick={() => setSelectedId(destination.id)}
              >
                <span className="min-w-0">
                  <span className="block truncate text-[12px] font-medium">{destination.label}</span>
                  {destination.subtitle ? <span className="block truncate text-[10px] text-slate-400">{destination.subtitle}</span> : null}
                </span>
                {selected ? <span className="h-2 w-2 rounded-full bg-sky-300" aria-hidden="true" /> : null}
              </button>
            );
          })}
        </div>

        <footer className="border-t border-white/10 p-3">
          <textarea
            className="mb-3 min-h-[52px] w-full resize-none rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-[12px] text-slate-100 outline-none placeholder:text-slate-500 focus:border-sky-300/50"
            placeholder="Add a comment…"
            value={caption}
            onChange={(event) => setCaption(event.target.value)}
          />
          <div className="flex justify-end gap-2">
            <button type="button" className="rounded-full px-3 py-1.5 text-[12px] text-slate-300 transition hover:bg-white/8 hover:text-white" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-full bg-sky-400 px-3 py-1.5 text-[12px] font-semibold text-slate-950 transition hover:bg-sky-300 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!selectedDestination}
              onClick={() => {
                if (selectedDestination) onForward(selectedDestination, caption);
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
