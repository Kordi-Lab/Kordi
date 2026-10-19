import { Extension, findParentNode, type Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

const isTable = (node: ProseMirrorNode) => node.type.name === 'table';

function isEmptyTable(table: ProseMirrorNode) {
  let empty = true;
  table.descendants((node) => {
    if (!empty) return false;
    if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') {
      empty = node.childCount === 1 && node.firstChild!.content.size === 0;
      return false;
    }
    return true;
  });
  return empty;
}

/** Removes the table holding a caret when every cell is empty; cells are isolating, so Backspace alone cannot leave them. */
export function deleteEmptyTable(editor: Editor) {
  const { selection } = editor.state;
  if (!selection.empty) return false;
  const table = findParentNode(isTable)(selection);
  if (!table || !isEmptyTable(table.node)) return false;
  return editor.commands.deleteTable();
}

/** Backspace or Delete in an empty table removes it. A full cell selection already does, through the table extension. */
export const DocumentTables = Extension.create({
  name: 'documentTables',
  priority: 110,
  addKeyboardShortcuts() {
    const remove = () => deleteEmptyTable(this.editor);
    return { Backspace: remove, Delete: remove, 'Mod-Backspace': remove, 'Mod-Delete': remove };
  },
});
