import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Check, Forward, Search, Users, X } from 'lucide-react';

import { AppDialog } from '@/components/ui/dialog';
import { filterForwardDestinations, forwardDestinationPath, type ForwardDestination } from '@/features/chat/messageForwarding';
import type { ForwardMessageSource } from '@/features/chat/messageActionMetadata';
import { formatDesktopLastActiveLabel } from '@/lib/time';

export type MessageForwardDialogProps = {
  sources: ForwardMessageSource[];
  destinations: ForwardDestination[];
  sourceLabel?: string;
  onClose: () => void;
  onForward: (destination: ForwardDestination, caption: string, onProgress?: (completed: number) => void) => void | Promise<void>;
};

const filters = [['all', 'All'], ['person', 'People'], ['group', 'Groups'], ['agent', 'Agents']] as const;

function sourcePreview(source: ForwardMessageSource) {
  return source.textPreview || (source.voiceMessage ? 'Voice message' : `${source.attachmentCount} attachment${source.attachmentCount === 1 ? '' : 's'}`);
}

function DestinationAvatar({ destination }: { destination: ForwardDestination }) {
  const [failed, setFailed] = useState(false);
  return <span className={`forward-avatar forward-avatar-${destination.kind ?? 'group'}`} aria-hidden="true">
    {destination.profileImageUrl && !failed
      ? <img src={destination.profileImageUrl} alt="" onError={() => setFailed(true)} />
      : destination.kind === 'person'
        ? destination.label.split(/\s+/).slice(0, 2).map((part) => Array.from(part)[0]).join('').toLocaleUpperCase()
        : destination.kind === 'agent' ? <Bot /> : <Users />}
  </span>;
}

export function MessageForwardDialog({ sources, destinations, sourceLabel, onClose, onForward }: MessageForwardDialogProps) {
  const [selectedId, setSelectedId] = useState('');
  const [caption, setCaption] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [status, setStatus] = useState<'idle' | 'sending' | 'error' | 'success' | 'closing'>('idle');
  const [error, setError] = useState('');
  const [completed, setCompleted] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const submittingRef = useRef(false);
  const successRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  const succeeded = status === 'success' || status === 'closing';

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => {
    if (!succeeded) return;
    successRef.current?.focus();
    const fade = window.setTimeout(() => setStatus('closing'), 2000);
    const close = window.setTimeout(() => onCloseRef.current(), 2200);
    return () => { window.clearTimeout(fade); window.clearTimeout(close); };
  }, [succeeded]);
  const selected = destinations.find((destination) => destination.id === selectedId);
  const visible = useMemo(() => filterForwardDestinations(destinations, query, filter), [destinations, query, filter]);
  const isBatch = sources.length > 1;
  const busy = status === 'sending';
  // A retry continues the same batch; changing its destination could resend completed messages.
  const locked = busy || status === 'error';

  function clearSearch() {
    setQuery(''); setFilter('all'); searchRef.current?.focus();
  }

  async function forward() {
    if (!selected || !sources.length || submittingRef.current || succeeded) return;
    submittingRef.current = true;
    setStatus('sending'); setError('');
    try {
      await onForward(selected, isBatch ? '' : caption, setCompleted);
      setStatus('success');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Couldn’t forward the message. Try again.');
      setStatus('error');
    } finally {
      submittingRef.current = false;
    }
  }

  return <AppDialog
    titleId="message-forward-dialog-title"
    onDismiss={onClose}
    dismissDisabled={busy}
    busy={busy}
    className={`app-transient-surface app-message-forward-dialog${succeeded ? " forward-confirmation" : ""}${status === "closing" ? " forward-confirmation-exit" : ""}`}
    backdropClassName={`forward-overlay${succeeded ? " forward-confirmation-overlay" : ""}`}
  >
    <div className="forward-content" data-message-forward-dialog="true" data-message-forward-mode={isBatch ? 'batch' : 'single'}>
      {succeeded ? <section ref={successRef} className="forward-success" role="status" tabIndex={-1}>
        <span className="forward-success-mark" aria-hidden="true"><Check /></span>
        <h2 id="message-forward-dialog-title">{isBatch ? 'Messages forwarded' : 'Message forwarded'}</h2>
      </section> : <>
        <header className="forward-header">
          <h2 id="message-forward-dialog-title">{isBatch ? `Forward ${sources.length} messages` : 'Forward message'}</h2>
          <button type="button" className="forward-icon-button" onClick={onClose} disabled={busy} aria-label="Close forward dialog"><X aria-hidden="true" /></button>
        </header>
        {!isBatch && sources[0] ? <section className="forward-source" aria-label="Message being forwarded">
          {sourceLabel ? <div className="forward-source-path"><Forward aria-hidden="true" /><span>From {sourceLabel}</span></div> : null}
          <p>{sources[0].senderLabel}: {sourcePreview(sources[0])}</p>
        </section> : null}
        <div className="forward-picker">
          <label className="sr-only" htmlFor="forward-search">Send to</label>
          <div className="forward-search">
            <Search aria-hidden="true" />
            <input ref={searchRef} id="forward-search" type="search" placeholder="Search people, groups, or agents" autoFocus autoComplete="off" value={query} aria-controls="forward-destinations" onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
              if (event.key === 'Enter') event.preventDefault();
              if (event.key === 'ArrowDown') { event.preventDefault(); resultsRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(); }
            }} />
            {query ? <button type="button" className="forward-icon-button" aria-label="Clear search" onClick={() => { setQuery(''); searchRef.current?.focus(); }}><X aria-hidden="true" /></button> : null}
          </div>
          <div className="forward-filters" role="group" aria-label="Destination type">
            {filters.map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}
          </div>
          <div className="forward-list-heading"><h3 id="forward-list-title">{query.trim() ? 'Search results' : 'Recent chats'}</h3>{query.trim() ? <span>{visible.length} {visible.length === 1 ? 'result' : 'results'}</span> : null}</div>
          <div id="forward-destinations" ref={resultsRef} className="forward-destinations" role="group" aria-labelledby="forward-list-title" data-message-forward-destinations="true" onKeyDown={(event) => {
            if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
            const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
            if (!buttons.length) return;
            event.preventDefault();
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
          }}>
            {visible.map((destination) => <button key={destination.id} type="button" className="forward-destination" disabled={locked} data-message-forward-destination={destination.id} aria-pressed={selectedId === destination.id} onClick={() => setSelectedId(destination.id)}>
              <DestinationAvatar destination={destination} />
              <span className="forward-identity"><span className="forward-row-title">{destination.label}</span><span className="forward-row-context">{[destination.parentLabel, destination.subtitle, destination.identityLabel].filter(Boolean).join(' · ')}</span></span>
              <span className="forward-row-meta"><span>{destination.updatedAtLabel || (destination.updatedAtMs ? formatDesktopLastActiveLabel(destination.updatedAtMs) : '')}</span><span className="forward-selection-check">{selectedId === destination.id ? <Check aria-hidden="true" /> : null}</span></span>
            </button>)}
            {!visible.length ? <div className="forward-empty"><Search aria-hidden="true" /><h3>{destinations.length ? 'No matching destinations' : 'No chats available to forward to.'}</h3>{destinations.length ? <><p>Try a name, group name, or Kordi ID.</p><button type="button" onClick={clearSearch}>Clear search and filters</button></> : null}</div> : null}
          </div>
          <span className="sr-only" role="status">{visible.length} destinations found.</span>
        </div>
        <footer className="app-transient-divider forward-footer">
          {selected ? <div className="forward-selection-summary" aria-live="polite">To <strong>{forwardDestinationPath(selected)}</strong></div> : null}
          {!isBatch ? <><label className="sr-only" htmlFor="forward-comment">Add a comment (optional)</label><textarea id="forward-comment" rows={1} placeholder="Add a comment (optional)" disabled={locked} value={caption} onChange={(event) => setCaption(event.target.value)} /></> : null}
          {status === 'error' ? <p className="forward-error" role="alert">{error}</p> : null}
          <div className="forward-actions"><button type="button" className="forward-secondary" disabled={busy} onClick={onClose}>Cancel</button><button type="button" className="forward-primary" disabled={!selected || !sources.length || busy} aria-busy={busy || undefined} onClick={() => { void forward(); }}><Forward aria-hidden="true" /><span aria-live="polite">{busy ? isBatch ? `Forwarding ${completed}/${sources.length}…` : 'Forwarding…' : status === 'error' ? 'Try again' : 'Forward'}</span></button></div>
        </footer>
      </>}
    </div>
  </AppDialog>;
}
