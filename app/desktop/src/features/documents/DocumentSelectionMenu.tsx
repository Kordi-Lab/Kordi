import { Braces, ChevronDown, Highlighter, Link2, List, MessageSquarePlus, SmilePlus } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { DOCUMENT_REACTIONS, EDITING_LIVES_ON_HOST } from './documentReaderModel';
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

/** Floating menu over the selected block: comment and react for everyone, formatting on the hosting Mac only. */
export function DocumentSelectionMenu({
  top,
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
  const formatTitle = (label: string) => (canFormat ? label : EDITING_LIVES_ON_HOST);
  const formatButton = ({ action, label, content, className }: MenuButton) => (
    <button
      key={action}
      type="button"
      className={className}
      aria-label={label}
      title={formatTitle(label)}
      aria-pressed={activeStyles.includes(action as DocumentBlockStyle) || undefined}
      disabled={!canFormat}
      onClick={() => onFormat(action)}
    >
      {content}
    </button>
  );

  return (
    <div
      className="app-document-selection"
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
        <span className="app-document-selection-separator" aria-hidden="true" />
        <button type="button" aria-label="Text style" title={formatTitle('Text style')} disabled={!canFormat} onClick={() => onFormat('heading')}>
          Aa
          <ChevronDown className="app-document-caret" aria-hidden="true" />
        </button>
        <span className="app-document-selection-separator" aria-hidden="true" />
        {STYLE_BUTTONS.map(formatButton)}
        <span className="app-document-selection-separator" aria-hidden="true" />
        {formatButton({ action: 'list', label: 'List', content: <><List aria-hidden="true" /><ChevronDown className="app-document-caret" aria-hidden="true" /></> })}
        <span className="app-document-selection-separator" aria-hidden="true" />
        {formatButton({ action: 'link', label: 'Link', content: <Link2 aria-hidden="true" /> })}
      </div>
    </div>
  );
}
