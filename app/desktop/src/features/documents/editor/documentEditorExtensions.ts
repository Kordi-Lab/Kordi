import type { AnyExtension } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import UniqueID from '@tiptap/extension-unique-id';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';

import { DocumentHighlight, DocumentUnderline } from './documentEditorMarks';
import { newBlockId } from '../newBlockId';

export { newBlockId };

/** Top-level block types that carry a stable id. */
export const BLOCK_TYPES = [
  'paragraph',
  'heading',
  'blockquote',
  'bulletList',
  'orderedList',
  'taskList',
  'codeBlock',
  'table',
  'image',
  'horizontalRule',
];

/** The editor's schema: Markdown nodes and marks the server renders, plus stable block ids. */
export function documentEditorExtensions(extra: AnyExtension[] = []): AnyExtension[] {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      underline: false,
      link: { openOnClick: false, autolink: true },
      trailingNode: false,
    }),
    DocumentUnderline,
    DocumentHighlight,
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    Image.configure({ inline: false, allowBase64: false }),
    UniqueID.configure({ types: BLOCK_TYPES, attributeName: 'id', generateID: () => newBlockId() }),
    Markdown.configure({ indentation: { style: 'space', size: 2 } }),
    ...extra,
  ];
}
