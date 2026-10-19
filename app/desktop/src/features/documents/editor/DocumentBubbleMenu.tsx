import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { Braces, Check, ChevronDown, Highlighter, Link2, List, MessageSquarePlus, SmilePlus, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';


import {
  DOCUMENT_REACTIONS,
  activeBlockStyle,
  activeFormats,
  selectionBlockId,
  setBlockStyle,
  setLink,
  toggleFormat,
  toggleList,
  type BlockStyle,
  type InlineFormat,
} from './documentEditorCommands';

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

/**
 * Floating menu on a non-empty selection. Comment and React act on the block
 * holding the selection; formatting shows where the viewer can edit.
 */
export function DocumentBubbleMenu({
  editor,
  canFormat,
  canComment,
  canReact,
  onComment,
  onReact,
}: {
  editor: Editor;
  canFormat: boolean;
  canComment: boolean;
  canReact: boolean;
  onComment: (blockId: string) => void;
  onReact: (blockId: string, reaction: string) => void;
}) {
  const [panel, setPanel] = useState<Panel>(null);
  const [url, setUrl] = useState('');
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      formats: activeFormats(current),
      style: activeBlockStyle(current),
      list: current.isActive('bulletList'),
      link: current.isActive('link'),
      table: current.isActive('table'),
    }),
  });
  const toggle = (next: Panel) => setPanel((current) => (current === next ? null : next));
  const blockId = () => selectionBlockId(editor);

  return (
    <BubbleMenu
      editor={editor}
      className="app-document-selection"
      data-kordi-keeps-selection="true"
      shouldShow={({ state: editorState }) => !editorState.selection.empty && (canFormat || canComment || canReact)}
      options={{ placement: 'top', offset: 8, flip: true, shift: { padding: 8 }, onHide: () => setPanel(null) }}
    >
      <div role="toolbar" aria-label="Selection" onMouseDown={(event) => { if (!(event.target instanceof HTMLInputElement)) event.preventDefault(); }}>
        {panel === 'react' ? (
          <div className="app-document-selection-panel app-document-emoji-row" role="menu" aria-label="Reactions">
            {DOCUMENT_REACTIONS.map((reaction) => (
              <button key={reaction} type="button" role="menuitem" aria-label={`React ${reaction}`} onClick={() => { const id = blockId(); setPanel(null); if (id) onReact(id, reaction); }}>
                {reaction}
              </button>
            ))}
          </div>
        ) : null}
        {panel === 'style' ? (
          <div className="app-document-selection-panel app-document-style-menu" role="menu" aria-label="Text style">
            {BLOCK_STYLES.map((entry) => (
              <button key={entry.style} type="button" role="menuitemradio" aria-checked={state.style === entry.style} onClick={() => { setPanel(null); setBlockStyle(editor, entry.style); }}>
                <span>{entry.label}</span>
                {state.style === entry.style ? <Check aria-hidden="true" /> : null}
              </button>
            ))}
          </div>
        ) : null}
        {panel === 'link' ? (
          <form
            className="app-document-selection-panel app-document-link-form"
            onSubmit={(event) => { event.preventDefault(); if (url.trim()) { setPanel(null); setLink(editor, url); setUrl(''); } }}
          >
            <input autoFocus type="url" value={url} placeholder="https://" aria-label="Link URL" onChange={(event) => setUrl(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setPanel(null); }} />
            <button type="submit" disabled={!url.trim()}>Add</button>
          </form>
        ) : null}
        <div className="app-document-selection-bar">
          <button type="button" aria-label="Comment" title="Comment" disabled={!canComment} onClick={() => { const id = blockId(); if (id) onComment(id); }}>
            <MessageSquarePlus aria-hidden="true" />
          </button>
          <button type="button" aria-label="React" title="React" aria-expanded={panel === 'react'} disabled={!canReact} onClick={() => toggle('react')}>
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
                <button key={format} type="button" className={className} aria-label={label} title={label} aria-pressed={state.formats.includes(format)} onClick={() => toggleFormat(editor, format)}>
                  {content}
                </button>
              ))}
              <span className="app-document-selection-separator" aria-hidden="true" />
              <button type="button" aria-label="List" title="List" aria-pressed={state.list} onClick={() => toggleList(editor)}>
                <List aria-hidden="true" />
              </button>
              <span className="app-document-selection-separator" aria-hidden="true" />
              <button
                type="button"
                aria-label="Link"
                title={state.link ? 'Remove link' : 'Link'}
                aria-pressed={state.link}
                aria-expanded={panel === 'link'}
                onClick={() => (state.link ? setLink(editor, '') : toggle('link'))}
              >
                <Link2 aria-hidden="true" />
              </button>
              {state.table ? (
                <>
                  <span className="app-document-selection-separator" aria-hidden="true" />
                  <button type="button" aria-label="Delete table" title="Delete table" onClick={() => editor.chain().focus().deleteTable().run()}>
                    <Trash2 aria-hidden="true" />
                  </button>
                </>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </BubbleMenu>
  );
}
