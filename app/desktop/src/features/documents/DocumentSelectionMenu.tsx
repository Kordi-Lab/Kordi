import { Braces, Check, ChevronDown, Highlighter, Link2, List, MessageSquarePlus, SmilePlus } from 'lucide-react';
import { useState, type ReactNode, type Ref } from 'react';

import type { BlockStyle, InlineFormat } from './documentFormat';
import { DOCUMENT_REACTIONS } from './documentReaderModel';

/** `panels` is where the reactions, Aa, and link panels open: toward the side with room. */
export type SelectionMenuPosition = { top: number; left: number; placement: 'above' | 'below'; panels: 'above' | 'below' };

export type SelectionMenuActive = { formats: InlineFormat[]; list: boolean; link: boolean; style: BlockStyle };

const STYLE_BUTTONS: Array<{ format: InlineFormat; label: string; content: ReactNode; className?: string }> = [
  { format: 'bold', label: 'Bold', content: 'B', className: 'is-bold' },
  { format: 'italic', label: 'Italic', content: 'I', className: 'is-italic' },
  { format: 'underline', label: 'Underline', content: 'U', className: 'is-underline' },
  { format: 'strike', label: 'Strikethrough', content: 'S', className: 'is-strike' },
  { format: 'code', label: 'Code', content: <Braces aria-hidden="true" /> },
  { format: 'highlight', label: 'Highlight', content: <Highlighter aria-hidden="true" /> },
];

const BLOCK_STYLES: Array<{ style: BlockStyle; label: string }> = [
  { style: 'text', label: 'Text' },
  { style: 'h1', label: 'Heading 1' },
  { style: 'h2', label: 'Heading 2' },
  { style: 'h3', label: 'Heading 3' },
  { style: 'quote', label: 'Quote' },
];

type Panel = 'react' | 'style' | 'link' | null;

/** Floating menu that follows the text selection. Formatting shows only where the viewer can edit. */
export function DocumentSelectionMenu({
  menuRef,
  position,
  canComment,
  canReact,
  canFormat,
  writeDisabledTitle,
  active,
  onComment,
  onReact,
  onFormat,
  onList,
  onBlockStyle,
  onLink,
}: {
  menuRef?: Ref<HTMLDivElement>;
  position: SelectionMenuPosition;
  canComment: boolean;
  canReact: boolean;
  canFormat: boolean;
  writeDisabledTitle: string;
  active: SelectionMenuActive;
  onComment: () => void;
  onReact: (reaction: string) => void;
  onFormat: (format: InlineFormat) => void;
  onList: () => void;
  onBlockStyle: (style: BlockStyle) => void;
  /** A URL wraps the text in a link; an empty string removes the link. */
  onLink: (url: string) => void;
}) {
  const [panel, setPanel] = useState<Panel>(null);
  const [url, setUrl] = useState('');
  const toggle = (next: Panel) => setPanel((current) => (current === next ? null : next));
  // Buttons keep the text selection; only the link field takes focus.
  const keepSelection = (event: { target: EventTarget; preventDefault: () => void }) => {
    if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
  };

  return (
    <div
      ref={menuRef}
      className="app-document-selection"
      data-placement={position.placement}
      data-panels={position.panels}
      style={{ top: position.top, left: position.left }}
      role="toolbar"
      aria-label="Selection"
      onMouseDown={keepSelection}
    >
      {panel === 'react' ? (
        <div className="app-document-selection-panel app-document-emoji-row" role="menu" aria-label="Reactions">
          {DOCUMENT_REACTIONS.map((reaction) => (
            <button key={reaction} type="button" role="menuitem" aria-label={`React ${reaction}`} onClick={() => { setPanel(null); onReact(reaction); }}>
              {reaction}
            </button>
          ))}
        </div>
      ) : null}
      {panel === 'style' ? (
        <div className="app-document-selection-panel app-document-style-menu" role="menu" aria-label="Text style">
          {BLOCK_STYLES.map((entry) => (
            <button key={entry.style} type="button" role="menuitemradio" aria-checked={active.style === entry.style} onClick={() => { setPanel(null); onBlockStyle(entry.style); }}>
              <span>{entry.label}</span>
              {active.style === entry.style ? <Check aria-hidden="true" /> : null}
            </button>
          ))}
        </div>
      ) : null}
      {panel === 'link' ? (
        <form
          className="app-document-selection-panel app-document-link-form"
          onSubmit={(event) => { event.preventDefault(); if (url.trim()) { setPanel(null); onLink(url); setUrl(''); } }}
        >
          <input
            autoFocus
            type="url"
            value={url}
            placeholder="https://"
            aria-label="Link URL"
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Escape') setPanel(null); }}
          />
          <button type="submit" disabled={!url.trim()}>Add</button>
        </form>
      ) : null}
      <div className="app-document-selection-bar">
        <button type="button" aria-label="Comment" title={canComment ? 'Comment' : writeDisabledTitle} disabled={!canComment} onClick={onComment}>
          <MessageSquarePlus aria-hidden="true" />
        </button>
        <button type="button" aria-label="React" title={canReact ? 'React' : writeDisabledTitle} aria-expanded={panel === 'react'} disabled={!canReact} onClick={() => toggle('react')}>
          <SmilePlus aria-hidden="true" />
        </button>
        {canFormat ? (
          <>
            <span className="app-document-selection-separator" aria-hidden="true" />
            <button type="button" aria-label="Text style" title="Text style" aria-expanded={panel === 'style'} onClick={() => toggle('style')}>
              Aa
              <ChevronDown className="app-document-caret" aria-hidden="true" />
            </button>
            <span className="app-document-selection-separator" aria-hidden="true" />
            {STYLE_BUTTONS.map(({ format, label, content, className }) => (
              <button key={format} type="button" className={className} aria-label={label} title={label} aria-pressed={active.formats.includes(format)} onClick={() => onFormat(format)}>
                {content}
              </button>
            ))}
            <span className="app-document-selection-separator" aria-hidden="true" />
            <button type="button" aria-label="List" title="List" aria-pressed={active.list} onClick={onList}>
              <List aria-hidden="true" />
            </button>
            <span className="app-document-selection-separator" aria-hidden="true" />
            <button
              type="button"
              aria-label="Link"
              title={active.link ? 'Remove link' : 'Link'}
              aria-pressed={active.link}
              aria-expanded={panel === 'link'}
              onClick={() => (active.link ? onLink('') : toggle('link'))}
            >
              <Link2 aria-hidden="true" />
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
