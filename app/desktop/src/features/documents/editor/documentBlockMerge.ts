import type { SourceBlock } from './documentBlockIds';

export type BlockMerge = { blocks: SourceBlock[]; conflict: boolean };

/**
 * Three-way merge of top-level blocks by id. Blocks changed only on one side
 * take that side; blocks changed on both sides take the remote text, except
 * the block being typed into, which keeps the local text. Either way a
 * both-sides change reports a conflict ("Updated elsewhere").
 */
export function mergeBlocks(
  base: readonly SourceBlock[],
  local: readonly SourceBlock[],
  remote: readonly SourceBlock[],
  currentId: string | null,
): BlockMerge {
  const baseById = new Map(base.map((block) => [block.id, block.source]));
  const localById = new Map(local.map((block) => [block.id, block.source]));
  const remoteIds = new Set(remote.map((block) => block.id));
  let conflict = false;
  const result: SourceBlock[] = [];

  for (const block of remote) {
    const before = baseById.get(block.id);
    const mine = localById.get(block.id);
    if (mine === undefined) {
      // Deleted here: the deletion stands unless the remote changed the block meanwhile.
      if (before === undefined) result.push(block);
      else if (before !== block.source) {
        conflict = true;
        result.push(block);
      }
      continue;
    }
    if (mine === before || mine === block.source) result.push(block);
    else if (block.source === before) result.push({ id: block.id, source: mine });
    else {
      conflict = true;
      result.push(block.id === currentId ? { id: block.id, source: mine } : block);
    }
  }

  // Blocks only here: new ones stay after their local predecessor; ones the remote deleted stay only if edited here.
  local.forEach((block, index) => {
    if (remoteIds.has(block.id)) return;
    const before = baseById.get(block.id);
    if (before !== undefined && before === block.source) return;
    if (before !== undefined) conflict = true;
    const previousId = local.slice(0, index).reverse().find((candidate) => result.some((entry) => entry.id === candidate.id))?.id;
    const at = previousId ? result.findIndex((entry) => entry.id === previousId) + 1 : 0;
    result.splice(at, 0, block);
  });

  return { blocks: result, conflict };
}
