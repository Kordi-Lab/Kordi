import type { AnyExtension } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import UniqueID from '@tiptap/extension-unique-id';
import Collaboration, { isChangeOrigin } from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';

import { DocumentCodeBlocks } from './documentCodeBlocks';
import { DocumentHighlight, DocumentUnderline } from './documentEditorMarks';
import { ROOM_FIELD, type CollabUser, type DocumentRoom } from './documentRoom';
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

/**
 * The editor's schema: Markdown nodes and marks the server renders, plus stable block ids.
 * In a collaboration room the content lives in the room's Y document, which brings its own undo history.
 */
export function documentEditorExtensions(extra: AnyExtension[] = [], collab: { room: DocumentRoom; user: CollabUser } | null = null): AnyExtension[] {
  return [
    StarterKit.configure({
      ...(collab ? { undoRedo: false as const } : {}),
      heading: { levels: [1, 2, 3] },
      underline: false,
      link: { openOnClick: false, autolink: true },
      trailingNode: false,
    }),
    DocumentUnderline,
    DocumentHighlight,
    DocumentCodeBlocks,
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    Image.configure({ inline: false, allowBase64: false }),
    UniqueID.configure({
      types: BLOCK_TYPES,
      attributeName: 'id',
      generateID: () => newBlockId(),
      // Remote changes from the room already carry their ids.
      filterTransaction: collab ? (transaction) => !isChangeOrigin(transaction) : null,
    }),
    Markdown.configure({ indentation: { style: 'space', size: 2 } }),
    ...(collab ? [
      Collaboration.configure({ document: collab.room.ydoc, field: ROOM_FIELD }),
      CollaborationCaret.configure({ provider: collab.room.provider, user: collab.user }),
    ] : []),
    ...extra,
  ];
}
