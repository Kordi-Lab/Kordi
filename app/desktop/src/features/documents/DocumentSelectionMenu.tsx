import { Braces, ChevronDown, Highlighter, Link2, List, MessageSquarePlus, SmilePlus } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { DOCUMENT_REACTIONS } from './documentReaderModel';
import type { DocumentBlockStyle, DocumentFormatAction } from './useDocumentEditing';

type MenuButton = { action: DocumentFormatAction; label: string; content: ReactNode; className?: string };

const STYLE_BUTTONS: MenuButton[] = [
  { action: 'bold', label: 'Bold', content: 'B', className: 'is-bold' },
  { action: 'italic', label: 'Italic', content: 'I', className: 'is-italic' },
  { action: 'underline', label: 'Underline', content: 'U', className: 'is-underline' },
  { action: 'strike', label: 'Strikethrough', content: 'S', className: 'is-strike' },
  { action: 'code', label: 'Code', content: <Braces aria-hidden="true" /> },
  { action: 'highlight', label: 'Highlight', content: <Highlighter aria-hidden="true" /> },
];

/** Floating menu at the selected block: comment and react for everyone; formatting only for a file on this Mac. */
export function DocumentSelectionMenu({
  top,
  placement,
  canComment,
  canReact,
  canFormat,
  writeDisabledTitle,
  activeStyles,
  onComment,
  onReact,
  onFormat,
}: {
  top: number;
  placement: 'above' | 'below';
  canComment: boolean;
  canReact: boolean;
  canFormat: boolean;
  writeDisabledTitle: string;
  activeStyles: DocumentBlockStyle[];
  onComment: () => void;
  onReact: (reaction: string) => void;
  onFormat: (action: DocumentFormatAction) => void;
}) {
  const [emojiOpen, setEmojiOpen] = useState(false);
  const formatButton = ({ action, label, content, className }: MenuButton) => (
    <button
      key={action}
      type="button"
      className={className}
      aria-label={label}
      title={label}
      aria-pressed={activeStyles.includes(action as DocumentBlockStyle) || undefined}
      onClick={() => onFormat(action)}
    >
      {content}
    </button>
  );

  return (
    <div
      className="app-document-selection"
      data-placement={placement}
      style={{ top }}
      role="toolbar"
      aria-label="Selection"
      onMouseDown={(event) => event.preventDefault()}
    >
      {emojiOpen ? (
        <div className="app-document-emoji-row" role="menu" aria-label="Reactions">
          {DOCUMENT_REACTIONS.map((reaction) => (
            <button key={reaction} type="button" role="menuitem" aria-label={`React ${reaction}`} onClick={() => { setEmojiOpen(false); onReact(reaction); }}>
              {reaction}
            </button>
          ))}
        </div>
      ) : null}
      <div className="app-document-selection-bar">
        <button type="button" aria-label="Comment" title={canComment ? 'Comment' : writeDisabledTitle} disabled={!canComment} onClick={onComment}>
          <MessageSquarePlus aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="React"
          title={canReact ? 'React' : writeDisabledTitle}
          aria-expanded={emojiOpen}
          disabled={!canReact}
          onClick={() => setEmojiOpen((open) => !open)}
        >
          <SmilePlus aria-hidden="true" />
        </button>
        {canFormat ? (
          <>
            <span className="app-document-selection-separator" aria-hidden="true" />
            <button type="button" aria-label="Text style" title="Text style" onClick={() => onFormat('heading')}>
              Aa
              <ChevronDown className="app-document-caret" aria-hidden="true" />
            </button>
            <span className="app-document-selection-separator" aria-hidden="true" />
            {STYLE_BUTTONS.map(formatButton)}
            <span className="app-document-selection-separator" aria-hidden="true" />
            {formatButton({ action: 'list', label: 'List', content: <><List aria-hidden="true" /><ChevronDown className="app-document-caret" aria-hidden="true" /></> })}
            <span className="app-document-selection-separator" aria-hidden="true" />
            {formatButton({ action: 'link', label: 'Link', content: <Link2 aria-hidden="true" /> })}
          </>
        ) : null}
      </div>
    </div>
  );
}
