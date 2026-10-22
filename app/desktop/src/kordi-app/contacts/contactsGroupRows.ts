import type { ParticipantSpaceViewModel } from '../types';

/** Joined group chats, newest activity first, narrowed by the contact search. */
export function contactsGroupRows(spaces: readonly ParticipantSpaceViewModel[], search: string) {
  const query = search.trim().toLowerCase();
  return spaces
    .filter((space) => space.kind === 'group' && space.sessions.length > 0)
    .filter((space) => !query || space.title.toLowerCase().includes(query))
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
}

/** Groups shown before the "Show all" button; a search always lists every match. */
export const GROUP_ROWS_PREVIEW = 5;

export function visibleGroupRows<T>(rows: readonly T[], search: string, showAll: boolean) {
  return showAll || search.trim() ? rows : rows.slice(0, GROUP_ROWS_PREVIEW);
}

export const GROUP_TILE_TONES = 6;

/** Stable tile colour index (1-based) for a group id. */
export function groupTileTone(id: string) {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return (hash % GROUP_TILE_TONES) + 1;
}

export function groupInitial(title: string) {
  return (Array.from(title.trim())[0] ?? '#').toUpperCase();
}
