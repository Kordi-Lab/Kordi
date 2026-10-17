import type { Editor, JSONContent } from '@tiptap/core';
import { Selection, TextSelection } from '@tiptap/pm/state';

import { parseBlocks, serializeBlocks, type SourceBlock } from './documentBlockIds';
import { mergeBlocks } from './documentBlockMerge';
import { selectionBlockId } from './documentEditorCommands';

/** Meta flag on transactions that bring in outside content (load, remote update); they are not user edits. */
export const OUTSIDE_CONTENT = 'documentOutsideContent';

/** Where the caret was, as block id plus offsets inside that block, so it survives a content swap. */
function selectionAnchor(editor: Editor) {
  const id = selectionBlockId(editor);
  if (!id) return null;
  let start = -1;
  editor.state.doc.forEach((node, offset) => { if (start < 0 && node.attrs.id === id) start = offset; });
  if (start < 0) return null;
  const { from, to } = editor.state.selection;
  return { id, from: from - start, to: to - start };
}

/** Replaces the document without touching undo history, keeping the caret in its block when that block survives. */
export function replaceDocument(editor: Editor, doc: JSONContent) {
  const anchor = selectionAnchor(editor);
  const node = editor.schema.nodeFromJSON(doc);
  const transaction = editor.state.tr.replaceWith(0, editor.state.doc.content.size, node.content);
  transaction.setMeta('addToHistory', false).setMeta(OUTSIDE_CONTENT, true);
  if (anchor) {
    let start = -1;
    let size = 0;
    transaction.doc.forEach((child, offset) => { if (start < 0 && child.attrs.id === anchor.id) { start = offset; size = child.nodeSize; } });
    if (start >= 0) {
      const clamp = (value: number) => Math.max(start + 1, Math.min(start + size - 1, start + value));
      transaction.setSelection(TextSelection.between(transaction.doc.resolve(clamp(anchor.from)), transaction.doc.resolve(clamp(anchor.to))));
    }
  } else {
    // Without a caret to keep, start at the top; a mapped selection can land on a trailing rule or image as a node selection.
    transaction.setSelection(Selection.atStart(transaction.doc));
  }
  editor.view.dispatch(transaction);
}

export type SyncState = {
  /** Blocks as last received from outside, normalized through the editor's serializer. */
  base: SourceBlock[];
  /** Index ids (`b3`) of a document saved before ids existed, and the `k:` ids they got here. */
  legacyIds: Record<string, string>;
};

/** Loads outside blocks into the editor; index ids take the `k:` ids chosen for them in `legacyIds`. */
export function loadBlocks(editor: Editor, blocks: readonly SourceBlock[], legacyIds: Record<string, string>): SyncState {
  const manager = editor.markdown!;
  const parsed = parseBlocks(editor, blocks, legacyIds);
  replaceDocument(editor, parsed.doc);
  return { base: serializeBlocks(manager, editor.getJSON()), legacyIds };
}

/** A `k:` id for every index id, chosen once when a document without ids opens. */
export function legacyIdsFor(blocks: readonly SourceBlock[], newId: () => string) {
  return Object.fromEntries(blocks.filter((block) => !block.id.startsWith('k:')).map((block) => [block.id, newId()]));
}

/**
 * Applies a newer outside version: blocks changed only remotely come in,
 * local edits stay, and the block being typed into keeps the local text when
 * both sides changed it. Returns the new sync state and whether both sides
 * touched the same block.
 */
export function applyRemoteBlocks(editor: Editor, sync: SyncState, blocks: readonly SourceBlock[], legacyIds: Record<string, string>) {
  const manager = editor.markdown!;
  const remoteDoc = parseBlocks(editor, blocks, legacyIds).doc;
  const remote = serializeBlocks(manager, remoteDoc);
  const local = serializeBlocks(manager, editor.getJSON());
  const same = (left: SourceBlock[], right: SourceBlock[]) => left.length === right.length && left.every((block, index) => block.id === right[index].id && block.source === right[index].source);
  if (same(remote, local)) return { sync: { base: remote, legacyIds }, conflict: false, localChanges: false };
  const merged = mergeBlocks(sync.base, local, remote, selectionBlockId(editor));
  if (!same(merged.blocks, local)) {
    replaceDocument(editor, parseBlocks(editor, merged.blocks).doc);
  }
  return { sync: { base: remote, legacyIds }, conflict: merged.conflict, localChanges: !same(merged.blocks, remote) };
}

/**
 * The room's content brought in line with the latest snapshot after a
 * revisioned save changed it outside the room: blocks whose Markdown differs
 * take the snapshot's version by id, snapshot blocks the room lacks are
 * inserted after their predecessor, and blocks only the room has stay.
 */
export function reconciledContent(editor: Editor, room: JSONContent, blocks: readonly SourceBlock[]): JSONContent {
  const manager = editor.markdown!;
  const snapshot = parseBlocks(editor, blocks).doc.content ?? [];
  const content = [...(room.content ?? [])];
  const sourceOf = (node: JSONContent) => serializeBlocks(manager, { type: 'doc', content: [node] })[0]?.source;
  const indexOf = (id: unknown) => content.findIndex((node) => node.attrs?.id === id);
  let previous: unknown = null;
  for (const node of snapshot) {
    const id: unknown = node.attrs?.id;
    const at = indexOf(id);
    if (at >= 0 && sourceOf(content[at]) !== sourceOf(node)) content[at] = node;
    if (at < 0) content.splice(previous === null ? 0 : indexOf(previous) + 1, 0, node);
    previous = id;
  }
  return { ...room, content };
}
