import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, FileText } from 'lucide-react';

import { cn } from '@/lib/utils';
import { documentsSummary } from './buildRequest';
import type { CommonGroundClient } from './client';
import { CgIcon, CgRow } from './parts';
import type { CgDocument } from './types';
import { usePopoverDismiss } from './usePopoverDismiss';
import { shortDay } from './wallet';

/** A card reads at most this many documents. */
export const MAX_DOCUMENTS = 8;

/** Your own Kordi documents: the count, and a checklist of up to eight to read. */
export function DocumentsRow({ client, chosen, onChange }: {
  client: Pick<CommonGroundClient, 'documents'>;
  chosen: string[];
  onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [documents, setDocuments] = useState<CgDocument[] | null>(null);
  const [failed, setFailed] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    let cancelled = false;
    void client.documents().then((list) => { if (!cancelled) setDocuments(list); }, () => { if (!cancelled) { setDocuments([]); setFailed(true); } });
    return () => { cancelled = true; };
  }, [client]);
  const full = chosen.length >= MAX_DOCUMENTS;
  const toggle = (id: string) => onChange(chosen.includes(id) ? chosen.filter((item) => item !== id) : full ? chosen : [...chosen, id]);
  return (
    <CgRow
      helpTarget="grounding-documents"
      lead={<CgIcon tone="accent"><FileText className="h-4 w-4" /></CgIcon>}
      title="Documents"
      trailing={(
        <span className="cg-docs-anchor" data-docs-anchor="">
          <button type="button" className="cg-docs-count" aria-expanded={open} onClick={() => setOpen(!open)}>
            {documentsSummary(chosen.length)}
            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          {open ? <DocumentsList documents={documents} failed={failed} chosen={chosen} full={full} onToggle={toggle} onClose={close} /> : null}
        </span>
      )}
    />
  );
}

function DocumentsList({ documents, failed, chosen, full, onToggle, onClose }: {
  documents: CgDocument[] | null;
  failed: boolean;
  chosen: string[];
  full: boolean;
  onToggle: (id: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  usePopoverDismiss(ref, '[data-docs-anchor]', onClose);
  let body;
  if (documents === null) body = <div className="cg-docs-empty">Loading…</div>;
  else if (failed) body = <div className="cg-docs-empty">Could not load documents.</div>;
  else if (!documents.length) body = <div className="cg-docs-empty">No documents you own yet</div>;
  else {
    body = documents.map((doc) => {
      const on = chosen.includes(doc.attachmentId);
      return (
        <button
          key={doc.attachmentId}
          type="button"
          aria-pressed={on}
          className={cn('cg-docs-item', on && 'is-on')}
          disabled={!on && full}
          onClick={() => onToggle(doc.attachmentId)}
        >
          <span className="cg-docs-check" aria-hidden="true">{on ? <Check className="h-3 w-3" /> : null}</span>
          <span className="cg-docs-text">
            <span className="cg-docs-title">{doc.title}</span>
            <span className="cg-docs-date">{shortDay(doc.updatedAt)}</span>
          </span>
        </button>
      );
    });
  }
  return <div ref={ref} className="cg-pop cg-docs-pop" role="dialog" aria-label="Documents">{body}</div>;
}
