import type { Editor } from '@tiptap/core';

import { insertBlock, setBlockStyle } from './documentEditorCommands';

export type SlashItem = { id: string; label: string; run: (editor: Editor, url?: string) => boolean; needsUrl?: boolean };

/** Blocks the `/` menu can insert. */
export const SLASH_ITEMS: SlashItem[] = [
  { id: 'text', label: 'Text', run: (editor) => setBlockStyle(editor, 'text') },
  { id: 'h1', label: 'Heading 1', run: (editor) => setBlockStyle(editor, 'h1') },
  { id: 'h2', label: 'Heading 2', run: (editor) => setBlockStyle(editor, 'h2') },
  { id: 'h3', label: 'Heading 3', run: (editor) => setBlockStyle(editor, 'h3') },
  { id: 'bullet', label: 'Bulleted list', run: (editor) => editor.chain().focus().toggleBulletList().run() },
  { id: 'ordered', label: 'Numbered list', run: (editor) => editor.chain().focus().toggleOrderedList().run() },
  { id: 'task', label: 'Task list', run: (editor) => editor.chain().focus().toggleTaskList().run() },
  { id: 'quote', label: 'Quote', run: (editor) => setBlockStyle(editor, 'quote') },
  { id: 'code', label: 'Code block', run: (editor) => editor.chain().focus().setCodeBlock().run() },
  { id: 'table', label: 'Table', run: (editor) => insertBlock(editor, 'table') },
  { id: 'image', label: 'Image', needsUrl: true, run: (editor, url = '') => insertBlock(editor, 'image', url) },
  { id: 'divider', label: 'Divider', run: (editor) => editor.chain().focus().setHorizontalRule().run() },
];

/** The `/query` typed at the start of an otherwise empty paragraph, with its range, or null. */
export function slashQuery(editor: Editor) {
  const { selection } = editor.state;
  if (!selection.empty) return null;
  const { $from } = selection;
  if ($from.parent.type.name !== 'paragraph' || $from.depth !== 1) return null;
  const text = $from.parent.textContent;
  const match = /^\/([\w ]{0,20})$/.exec(text);
  if (!match || $from.parentOffset !== text.length) return null;
  return { query: match[1].toLowerCase(), from: $from.start(), to: $from.pos };
}

export function slashMatches(query: string) {
  const needle = query.trim();
  return needle ? SLASH_ITEMS.filter((item) => item.label.toLowerCase().includes(needle)) : SLASH_ITEMS;
}
