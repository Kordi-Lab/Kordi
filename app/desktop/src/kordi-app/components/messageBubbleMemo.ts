export function messageBubblePinnedIdsEqual(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) {
  if (left === right) return true;
  if ((left?.length ?? 0) !== (right?.length ?? 0)) return false;
  return (left ?? []).every((value, index) => value === right?.[index]);
}
