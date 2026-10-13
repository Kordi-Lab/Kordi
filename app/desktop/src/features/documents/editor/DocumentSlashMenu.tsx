import type { Editor } from '@tiptap/core';
import { useState } from 'react';

import { slashMatches, type SlashItem } from './documentSlashItems';

/** The `/` menu: blocks to insert at the caret, filtered by what follows the slash. */
export function DocumentSlashMenu({
  editor,
  query,
  range,
  position,
  activeIndex,
  onClose,
}: {
  editor: Editor;
  query: string;
  range: { from: number; to: number };
  position: { top: number; left: number };
  activeIndex: number;
  onClose: () => void;
}) {
  const [urlFor, setUrlFor] = useState<SlashItem | null>(null);
  const [url, setUrl] = useState('');
  const items = slashMatches(query);

  const choose = (item: SlashItem, value?: string) => {
    if (item.needsUrl && value === undefined) {
      setUrlFor(item);
      return;
    }
    editor.chain().focus().deleteRange(range).run();
    item.run(editor, value);
    onClose();
  };

  return (
    <div className="app-document-menu app-document-slash-menu" role="menu" aria-label="Insert block" style={position} onMouseDown={(event) => { if (!(event.target instanceof HTMLInputElement)) event.preventDefault(); }}>
      {urlFor ? (
        <form className="app-document-link-form" onSubmit={(event) => { event.preventDefault(); if (url.trim()) choose(urlFor, url); }}>
          <input autoFocus type="url" value={url} placeholder="https://" aria-label="Image URL" onChange={(event) => setUrl(event.target.value)} />
          <button type="submit" disabled={!url.trim()}>Add</button>
        </form>
      ) : items.length === 0 ? (
        <div className="app-document-menu-row">No blocks</div>
      ) : items.map((item, index) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          data-slash-item={item.id}
          aria-selected={index === activeIndex}
          className="app-document-menu-row"
          onClick={() => choose(item)}
        >
          <span className="app-document-menu-label">{item.label}</span>
        </button>
      ))}
    </div>
  );
}
