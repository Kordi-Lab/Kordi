import { CalendarDays, ExternalLink, Share } from 'lucide-react';
import { useCallback, useRef, useState, type ReactNode } from 'react';

import type { DocumentReaderPerson } from './documentReaderHost';
import { PeopleCard } from './PeopleCard';
import { useOutsideDismiss } from './useOutsideDismiss';

export type DocumentBadge = 'local' | 'cloud' | null;

/** Top bar of the reader: file name, where the file lives, and the Share popover. */
export function DocumentHeader({
  fileName,
  badge,
  shareOpen,
  onToggleShare,
  sharePopover,
  onOpenSession,
}: {
  fileName: string;
  badge: DocumentBadge;
  shareOpen: boolean;
  onToggleShare?: () => void;
  sharePopover?: ReactNode;
  onOpenSession?: () => void;
}) {
  return (
    <div className="app-document-header">
      <div className="app-document-header-name">
        <span className="app-document-file-name" title={fileName}>{fileName}</span>
        {badge ? (
          <span className="app-document-badge" data-cloud={badge === 'cloud' ? 'true' : undefined}>
            {badge === 'cloud' ? 'In Kordi' : 'On this Mac'}
          </span>
        ) : null}
      </div>
      <div className="app-document-header-actions">
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

/** Title, date pill, and the `@author` chip that opens the People card. */
export function DocumentTitleMeta({
  title,
  dateLabel,
  author,
  canMessageAuthor,
  onMessageAuthor,
}: {
  title: string;
  dateLabel: string | null;
  author: DocumentReaderPerson | null;
  canMessageAuthor: boolean;
  onMessageAuthor?: () => void;
}) {
  const [peopleOpen, setPeopleOpen] = useState(false);
  const metaRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setPeopleOpen(false), []);
  useOutsideDismiss(metaRef, peopleOpen, close);
  return (
    <>
      <h1 className="app-document-title">{title}</h1>
      <div className="app-document-meta" ref={metaRef}>
        {dateLabel ? (
          <span className="app-document-pill">
            <CalendarDays aria-hidden="true" />
            {dateLabel}
          </span>
        ) : null}
        {dateLabel && author ? <span className="app-document-meta-dot" aria-hidden="true">·</span> : null}
        {author ? (
          <button
            type="button"
            className="app-document-mention"
            aria-expanded={peopleOpen}
            aria-haspopup="dialog"
            onClick={() => setPeopleOpen((open) => !open)}
          >
            @{author.displayName}
          </button>
        ) : null}
        {peopleOpen && author ? (
          <PeopleCard
            person={author}
            onMessage={canMessageAuthor && onMessageAuthor ? () => { close(); onMessageAuthor(); } : undefined}
          />
        ) : null}
      </div>
    </>
  );
}
