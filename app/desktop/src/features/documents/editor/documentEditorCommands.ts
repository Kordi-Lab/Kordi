import type { Editor, JSONContent } from '@tiptap/core';

/** Reactions the bubble menu offers. */
export const DOCUMENT_REACTIONS = ['❤️', '👍', '🔥', '👀', '🤔', '🎉'] as const;

export type BlockStyle = 'text' | 'h1' | 'h2' | 'h3' | 'quote';
export type InsertTool = 'code' | 'table' | 'image' | 'checklist';
export type InlineFormat = 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'highlight';

const MARK_TOGGLES: Record<InlineFormat, (editor: Editor) => boolean> = {
  bold: (editor) => editor.chain().focus().toggleBold().run(),
  italic: (editor) => editor.chain().focus().toggleItalic().run(),
  underline: (editor) => editor.chain().focus().toggleUnderline().run(),
  strike: (editor) => editor.chain().focus().toggleStrike().run(),
  code: (editor) => editor.chain().focus().toggleCode().run(),
  highlight: (editor) => editor.chain().focus().toggleHighlight().run(),
};

export function toggleFormat(editor: Editor, format: InlineFormat) {
  return MARK_TOGGLES[format](editor);
}

export function activeFormats(editor: Editor): InlineFormat[] {
  return (Object.keys(MARK_TOGGLES) as InlineFormat[]).filter((format) => editor.isActive(format));
}

export function activeBlockStyle(editor: Editor): BlockStyle {
  if (editor.isActive('blockquote')) return 'quote';
  for (const level of [1, 2, 3] as const) if (editor.isActive('heading', { level })) return `h${level}`;
  return 'text';
}

/** Aa: paragraph, heading 1 to 3, or quote for the block holding the selection. */
export function setBlockStyle(editor: Editor, style: BlockStyle) {
  const chain = editor.chain().focus();
  if (editor.isActive('blockquote') && style !== 'quote') chain.lift('blockquote');
  if (style === 'text') return chain.setParagraph().run();
  if (style === 'quote') return editor.isActive('blockquote') ? chain.run() : chain.setParagraph().wrapIn('blockquote').run();
  return chain.setHeading({ level: Number(style.slice(1)) as 1 | 2 | 3 }).run();
}

export function toggleList(editor: Editor) {
  return editor.chain().focus().toggleBulletList().run();
}

/** Adds a link to the selection, or removes the link under it when `url` is empty. */
export function setLink(editor: Editor, url: string) {
  const href = url.trim();
  if (!href) return editor.chain().focus().extendMarkRange('link').unsetLink().run();
  return editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
}

const TASK_LIST: JSONContent = {
  type: 'taskList',
  content: [{ type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph' }] }],
};

/** The tab-bar insert tools and the slash menu add real blocks at the caret. */
export function insertBlock(editor: Editor, tool: InsertTool, url = '') {
  const chain = editor.chain().focus();
  if (tool === 'code') return chain.insertContent({ type: 'codeBlock' }).run();
  if (tool === 'table') return chain.insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run();
  if (tool === 'image') return url.trim() ? chain.setImage({ src: url.trim() }).run() : false;
  return chain.insertContent(TASK_LIST).run();
}

/** Id of the top-level block that holds the selection. */
export function selectionBlockId(editor: Editor) {
  const { $from } = editor.state.selection;
  const node = $from.depth >= 1 ? $from.node(1) : editor.state.doc.nodeAt($from.pos);
  return typeof node?.attrs.id === 'string' ? node.attrs.id : null;
}
