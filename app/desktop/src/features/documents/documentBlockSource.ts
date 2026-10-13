import { splitMarkdownBlocks } from './documentBlocks';

/** `<!-- k:xxxx -->` on its own line after a block (written today), or at the end of a paragraph's or heading's last line (older form). */
const ID_COMMENT = /[ \t]*<!--\s*(k:[A-Za-z0-9_-]{4,32})\s*-->[ \t]*$/;

/** A block as the server lists it: index ids (`b3`) until it has a stamped id (`k:…`). */
export type SourceBlock = { id: string; source: string };

/** Splits stored Markdown into blocks, reading each block's id comment. */
export function blocksFromSource(source: string): SourceBlock[] {
  return splitMarkdownBlocks(source).map((block, index) => withoutIdComment({ id: `b${index}`, source: block.source }));
}

/** Moves a block's id comment out of its source into its id. */
export function withoutIdComment(block: SourceBlock): SourceBlock {
  const lines = block.source.split('\n');
  const last = lines[lines.length - 1] ?? '';
  const match = ID_COMMENT.exec(last);
  if (!match) return block;
  if (last.trim() === match[0].trim()) lines.pop();
  else lines[lines.length - 1] = last.replace(ID_COMMENT, '');
  return { id: match[1], source: lines.join('\n').replace(/\s+$/, '') };
}
