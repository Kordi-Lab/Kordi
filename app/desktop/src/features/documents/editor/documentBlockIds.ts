import type { JSONContent } from '@tiptap/core';
import type { MarkdownManager } from '@tiptap/markdown';

import { withoutIdComment, type SourceBlock } from '../documentBlockSource';
import { newBlockId } from '../newBlockId';

export { blocksFromSource, withoutIdComment, type SourceBlock } from '../documentBlockSource';

/** A parsed document: its nodes, and the index id each node came from (for documents saved before ids existed). */
export type ParsedDocument = { doc: JSONContent; legacyIds: Record<string, string> };

/**
 * Parses blocks one at a time, so every block keeps its id: a `k:` id is
 * reused, an index id gets a new `k:` id and is remembered for the first save.
 */
export function parseBlocks(manager: MarkdownManager, blocks: readonly SourceBlock[], knownLegacyIds: Record<string, string> = {}): ParsedDocument {
  const content: JSONContent[] = [];
  const legacyIds: Record<string, string> = {};
  for (const entry of blocks) {
    const block = withoutIdComment(entry);
    const nodes = (manager.parse(block.source).content ?? []).filter((node) => node.type);
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

/** One top-level node as Markdown, with its id comment on the last line. */
export function serializeBlock(manager: MarkdownManager, node: JSONContent) {
  const markdown = manager.serialize({ type: 'doc', content: [node] }).replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '');
  const id = typeof node.attrs?.id === 'string' && node.attrs.id.startsWith('k:') ? node.attrs.id : null;
  if (!markdown.trim()) return '';
  return id ? `${markdown} <!-- ${id} -->` : markdown;
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
