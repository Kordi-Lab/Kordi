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
