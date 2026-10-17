import type { Editor, JSONContent } from '@tiptap/core';
import type { MarkdownManager } from '@tiptap/markdown';

import { withoutIdComment, type SourceBlock } from '../documentBlockSource';
import { newBlockId } from '../newBlockId';
import { fitToSchema } from './documentSchemaFit';

export { blocksFromSource, withoutIdComment, type SourceBlock } from '../documentBlockSource';

/** A parsed document: its nodes, and the index id each node came from (for documents saved before ids existed). */
export type ParsedDocument = { doc: JSONContent; legacyIds: Record<string, string> };

/**
 * Parses blocks one at a time, so every block keeps its id: a `k:` id is
 * reused, an index id gets a new `k:` id and is remembered for the first save.
 * Parsed nodes are fitted to the editor's schema, so no Markdown makes it throw.
 */
export function parseBlocks(editor: Pick<Editor, 'markdown' | 'schema'>, blocks: readonly SourceBlock[], knownLegacyIds: Record<string, string> = {}): ParsedDocument {
  const content: JSONContent[] = [];
  const legacyIds: Record<string, string> = {};
  for (const entry of blocks) {
    const block = withoutIdComment(entry);
    const parsed = (editor.markdown!.parse(block.source).content ?? []).filter((node) => node.type);
    const nodes = fitToSchema(editor.schema, parsed);
    nodes.forEach((node, index) => {
      // The id comment belongs to the block's last node.
      const keep = index === nodes.length - 1 && block.id.startsWith('k:');
      const last = index === nodes.length - 1;
      const id = keep ? block.id : (last && knownLegacyIds[block.id]) || newBlockId();
      if (index === nodes.length - 1 && !block.id.startsWith('k:')) legacyIds[block.id] = id;
      content.push({ ...node, attrs: { ...(node.attrs ?? {}), id } });
    });
  }
  if (content.length === 0) content.push({ type: 'paragraph', attrs: { id: newBlockId() } });
  return { doc: { type: 'doc', content }, legacyIds };
}

const BARE_LIST_MARKER = /^([ \t]*(?:[-*+]|\d{1,9}[.)]))[ \t]+$/gm;
const MARKER_THEN_IMAGE = /^([ \t]*(?:[-*+]|\d{1,9}[.)]))\n[ \t]+(!\[)/gm;
const LIST_TYPES = new Set(['bulletList', 'orderedList', 'taskList']);

/**
 * A list as the parser reads it back: an item that starts empty or with a
 * nested block (see `fitToSchema`) is its marker alone on the line, since a
 * trailing space would end the item there; an item that starts with an image
 * keeps the image on the marker's line.
 */
function listMarkdown(markdown: string) {
  return markdown.replace(BARE_LIST_MARKER, '$1').replace(MARKER_THEN_IMAGE, '$1 $2');
}

/** One top-level node as Markdown, with its id comment on its own line right after it (valid CommonMark for every block type). */
export function serializeBlock(manager: MarkdownManager, node: JSONContent) {
  const serialized = manager.serialize({ type: 'doc', content: [node] }).replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '');
  const markdown = LIST_TYPES.has(String(node.type)) ? listMarkdown(serialized) : serialized;
  const id = typeof node.attrs?.id === 'string' && node.attrs.id.startsWith('k:') ? node.attrs.id : null;
  if (!markdown.trim()) return '';
  return id ? `${markdown}\n<!-- ${id} -->` : markdown;
}

/** Top-level blocks of a document: id and Markdown (with the id comment). */
export function serializeBlocks(manager: MarkdownManager, doc: JSONContent): SourceBlock[] {
  return (doc.content ?? []).flatMap((node) => {
    const source = serializeBlock(manager, node);
    return source ? [{ id: String(node.attrs?.id ?? ''), source }] : [];
  });
}

export function sourceOfBlocks(blocks: readonly SourceBlock[]) {
  return blocks.map((block) => block.source).join('\n\n');
}
