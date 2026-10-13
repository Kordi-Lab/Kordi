import { Code2, Image, ListChecks, Table2 } from 'lucide-react';
import { useCallback, useRef, useState, type ComponentType } from 'react';

import type { DocumentInsertTool } from './documentReaderModel';
import { useOutsideDismiss } from './useOutsideDismiss';

const TOOLS: Array<{ tool: DocumentInsertTool; label: string; icon: ComponentType<{ className?: string }> } | 'separator'> = [
  { tool: 'code', label: 'Code block', icon: Code2 },
  'separator',
  { tool: 'table', label: 'Table', icon: Table2 },
  { tool: 'image', label: 'Image', icon: Image },
  { tool: 'checklist', label: 'Checklist', icon: ListChecks },
];

/** Thin toolbar of a Markdown document the viewer can edit: the insert tools, right-aligned. Each adds a block after the current one. */
export function DocumentInsertBar({ onInsert }: { onInsert: (tool: DocumentInsertTool, url?: string) => void }) {
  const [imageOpen, setImageOpen] = useState(false);
  const [imageUrl, setImageUrl] = useState('');
  const barRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setImageOpen(false), []);
  useOutsideDismiss(barRef, imageOpen, close);

  return (
    <div className="app-document-insertbar" ref={barRef}>
      <div className="app-document-tools" role="group" aria-label="Insert">
        {TOOLS.map((entry, index) => (entry === 'separator'
          ? <span key={`separator-${index}`} className="app-document-insertbar-separator" aria-hidden="true" />
          : (
            <button
              key={entry.tool}
              type="button"
              className="app-document-tool"
              aria-label={entry.label}
              title={entry.label}
              aria-expanded={entry.tool === 'image' ? imageOpen : undefined}
              onClick={() => (entry.tool === 'image' ? setImageOpen((open) => !open) : onInsert(entry.tool))}
            >
              <entry.icon aria-hidden="true" />
            </button>
          )))}
      </div>
      {imageOpen ? (
        <form
          className="app-document-menu app-document-image-form"
          onSubmit={(event) => { event.preventDefault(); if (imageUrl.trim()) { onInsert('image', imageUrl); setImageUrl(''); close(); } }}
        >
          <input autoFocus type="url" value={imageUrl} placeholder="https://" aria-label="Image URL" onChange={(event) => setImageUrl(event.target.value)} />
          <button type="submit" disabled={!imageUrl.trim()}>Add</button>
        </form>
      ) : null}
    </div>
  );
}
