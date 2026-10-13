import { Globe, Lock, MessageSquare, RotateCw } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';

import { DocumentBlockAnnotations, type DocumentBlockThreadProps } from './DocumentBlock';
import type { CommentThread, ReactionPill } from './documentReaderModel';
import { themedDocumentSource, type DocumentTheme } from './documentTheme';
import { useOutsideDismiss } from './useOutsideDismiss';

/** Start of the browser bar: reload, then the file name where a browser shows the address. */
export function DocumentBrowserLead({ fileName, linkOn, onReload }: {
  fileName: string;
  /** Anyone with the link can read the page. */
  linkOn: boolean;
  onReload: () => void;
}) {
  const Icon = linkOn ? Globe : Lock;
  return (
    <>
      <button type="button" className="app-document-browser-button" aria-label="Reload" title="Reload" onClick={onReload}>
        <RotateCw aria-hidden="true" />
      </button>
      <div className="app-document-address" title={fileName}>
        <Icon aria-hidden="true" />
        <span>{fileName}</span>
      </div>
    </>
  );
}

/**
 * The author's page as a browser shows it, at the pane's width: it reflows or
 * scrolls inside the frame. Scripts never run and links cannot navigate (empty
 * sandbox, no same origin).
 */
export function DocumentHtmlFrame({ fileName, source, theme }: { fileName: string; source: string; theme: DocumentTheme }) {
  const srcDoc = useMemo(() => themedDocumentSource(source, theme), [source, theme]);
  return (
    <iframe
      title={`${fileName} preview`}
      sandbox=""
      srcDoc={srcDoc}
      className="app-document-frame"
      style={{ background: 'transparent', colorScheme: theme.scheme }}
      {...{ allowtransparency: 'true' }}
    />
  );
}

/** Reactions and comments of an HTML document (its one block) under the page: pills left, the thread popover right. */
export function DocumentAnnotationBar({ blockId, pills, threads, shared }: {
  blockId: string;
  pills: ReactionPill[];
  threads: CommentThread[];
  shared: DocumentBlockThreadProps;
}) {
  const [open, setOpen] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useOutsideDismiss(barRef, open, close);
  // The field stays for the next comment after one is posted; Escape and a press outside close the popover.
  const popoverShared = useMemo(() => ({ ...shared, onCancelComposer: () => undefined }), [shared]);
  const count = threads.reduce((total, thread) => total + 1 + thread.replies.length, 0);
  const hasComments = shared.canComment || threads.length > 0;
  if (pills.length === 0 && !hasComments) return null;

  return (
    <div ref={barRef} className="app-document-annotation-bar" data-document-block={blockId}>
      <div className="app-document-annotation-bar-reactions">
        <DocumentBlockAnnotations id={blockId} pills={pills} threads={[]} composing={false} shared={shared} />
      </div>
      {hasComments ? (
        <button
          type="button"
          className="app-document-comment-toggle"
          aria-label={count > 0 ? `Comments ${count}` : 'Comment'}
          title={count > 0 ? 'Comments' : 'Comment'}
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={() => setOpen((value) => !value)}
        >
          <MessageSquare aria-hidden="true" />
          {count > 0 ? <span>{count}</span> : null}
        </button>
      ) : null}
      {open ? (
        <div className="app-document-annotation-popover" role="dialog" aria-label="Comments">
          <DocumentBlockAnnotations id={blockId} pills={[]} threads={threads} composing={shared.canComment} shared={popoverShared} />
        </div>
      ) : null}
    </div>
  );
}
