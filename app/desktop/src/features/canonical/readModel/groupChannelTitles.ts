import type { CanonicalSessionState } from '@/kordi-app/types';

import { sessionMetadata } from './conversationMapping';

export function defaultGroupChannelTitles(
  sessions: CanonicalSessionState['sessions'],
) {
  const titles = new Map<string, string>();
  const sessionsBySpace = new Map<string, typeof sessions>();
  for (const session of sessions) {
    if (session.kind !== 'group') continue;
    const metadata = sessionMetadata(session);
    const rawSpaceId = [metadata.groupSpaceId, metadata.groupId]
      .find((value): value is string => typeof value === 'string' && Boolean(value.trim()))
      ?.trim() ?? session.id;
    const spaceId = rawSpaceId.replace(/^(?:group:)+/, '');
    sessionsBySpace.set(spaceId, [...(sessionsBySpace.get(spaceId) ?? []), session]);
  }
  for (const groupedSessions of sessionsBySpace.values()) {
    [...groupedSessions]
      .sort((left, right) => left.createdAtMs - right.createdAtMs || left.id.localeCompare(right.id))
      .forEach((session, index) => titles.set(session.id, `Channel ${index + 1}`));
  }
  return titles;
}

export function groupChannelFallbackTitle(
  session: CanonicalSessionState['sessions'][number],
  preferPersistedTitle: boolean,
  legacyTitle: string | undefined,
  defaults: ReadonlyMap<string, string>,
) {
  if (session.kind !== 'group') return null;
  return legacyTitle
    || (preferPersistedTitle ? session.title : '')
    || defaults.get(session.id)
    || 'Channel 1';
}
