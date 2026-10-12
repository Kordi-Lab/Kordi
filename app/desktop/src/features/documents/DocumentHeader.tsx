import { CalendarDays, ExternalLink, Share } from 'lucide-react';
import { useCallback, useRef, useState, type ReactNode } from 'react';

import type { DocumentPresencePeer } from './documentPresence';
import type { DocumentReaderPerson } from './documentReaderHost';
import { PeopleCard } from './PeopleCard';
import { useOutsideDismiss } from './useOutsideDismiss';

/** Only a file that lives on this Mac (no cloud copy) is marked. */
export type DocumentBadge = 'local' | null;

const MAX_PRESENCE = 4;

/**
 * Top bar of the reader in one row: the document title, the date, the
 * `@author` chip, who else is editing, and Share. A document that opens with
 * its own level-1 heading shows no title here.
 */
export function DocumentHeader({
  title,
  dateLabel,
  author,
  canMessageAuthor,
  onMessageAuthor,
  badge,
  shareOpen,
  onToggleShare,
  sharePopover,
  presence = [],
  onOpenSession,
}: {
  /** Null when the document's first heading is its title. */
  title: string | null;
  dateLabel: string | null;
  author: DocumentReaderPerson | null;
  canMessageAuthor: boolean;
  onMessageAuthor?: () => void;
  badge: DocumentBadge;
  shareOpen: boolean;
  onToggleShare?: () => void;
  sharePopover?: ReactNode;
  /** Other people editing in the collaboration room. */
  presence?: DocumentPresencePeer[];
  onOpenSession?: () => void;
}) {
  return (
    <div className={title ? 'app-document-header has-title' : 'app-document-header'}>
      {title ? <h1 className="app-document-header-title" title={title}>{title}</h1> : null}
      <div className="app-document-header-meta">
        {dateLabel ? (
          <span className="app-document-pill app-document-date">
            <CalendarDays aria-hidden="true" />
            {dateLabel}
          </span>
        ) : null}
        {author ? <AuthorChip author={author} canMessage={canMessageAuthor} onMessage={onMessageAuthor} /> : null}
        {badge === 'local' ? <span className="app-document-badge">On this Mac</span> : null}
      </div>
      <div className="app-document-header-actions">
        {presence.length > 0 ? <DocumentPresence peers={presence} /> : null}
        {onOpenSession ? (
          <button type="button" className="app-document-header-button" onClick={onOpenSession}>
            <ExternalLink aria-hidden="true" />
            Open in session
          </button>
        ) : null}
        {onToggleShare ? (
          <button
            type="button"
            className="app-document-header-button"
            aria-expanded={shareOpen}
            aria-haspopup="dialog"
            onClick={onToggleShare}
          >
            <Share aria-hidden="true" />
            Share
          </button>
        ) : null}
      </div>
      {shareOpen ? sharePopover : null}
    </div>
  );
}

/** The `@author` chip; it opens the People card. */
function AuthorChip({ author, canMessage, onMessage }: { author: DocumentReaderPerson; canMessage: boolean; onMessage?: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useOutsideDismiss(ref, open, close);
  return (
    <span className="app-document-author" ref={ref}>
      <button
        type="button"
        className="app-document-mention"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
      >
        @{author.displayName}
      </button>
      {open ? <PeopleCard person={author} onMessage={canMessage && onMessage ? () => { close(); onMessage(); } : undefined} /> : null}
    </span>
  );
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}

/** Who else is editing, one colored initials circle each (their caret color). */
function DocumentPresence({ peers }: { peers: DocumentPresencePeer[] }) {
  const shown = peers.slice(0, MAX_PRESENCE);
  const names = peers.map((peer) => peer.name).join(', ');
  return (
    <div className="app-document-presence" role="group" aria-label={`Editing: ${names}`} title={names}>
      {shown.map((peer) => (
        <span key={peer.clientId} className="app-document-presence-avatar" style={{ backgroundColor: peer.color }} data-account-id={peer.accountId ?? undefined}>
          {initials(peer.name)}
        </span>
      ))}
      {peers.length > shown.length ? <span className="app-document-presence-more">+{peers.length - shown.length}</span> : null}
    </div>
  );
}
