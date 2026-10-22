import assert from 'node:assert/strict';
import { test } from 'node:test';

import { contactsGroupRows } from '../src/kordi-app/contacts/contactsGroupRows';
import type { ParticipantSpaceViewModel } from '../src/kordi-app/types';
import { renderContactsPage } from './helpers/contactsPageFixtures';

function space(overrides: Partial<ParticipantSpaceViewModel> = {}): ParticipantSpaceViewModel {
  return {
    id: 'group:one',
    kind: 'group',
    title: 'Poster session',
    participants: [
      { id: 'me', name: 'Me', kind: 'human', role: 'self' },
      { id: 'hana', name: 'Hana', kind: 'human' },
      { id: 'agent', name: 'Agent', kind: 'agent' },
    ] as ParticipantSpaceViewModel['participants'],
    participantCount: 3,
    sessionCount: 1,
    unread: 0,
    updatedAtMs: 2,
    updatedAtLabel: '09:41',
    preview: '',
    avatarStack: [],
    sessions: [{ id: 'session-1' } as ParticipantSpaceViewModel['sessions'][number]],
    ...overrides,
  };
}

test('groups list joined groups only, newest first, filtered by the contact search', () => {
  const spaces = [
    space({ id: 'group:old', title: 'Reading club', updatedAtMs: 1 }),
    space({ id: 'group:new', title: 'Poster session', updatedAtMs: 5 }),
    space({ id: 'direct', kind: 'direct-human', title: 'Hana' }),
    space({ id: 'group:empty', title: 'Empty', sessions: [] }),
  ];
  assert.deepEqual(contactsGroupRows(spaces, '').map((row) => row.id), ['group:new', 'group:old']);
  assert.deepEqual(contactsGroupRows(spaces, ' read ').map((row) => row.id), ['group:old']);
  assert.deepEqual(contactsGroupRows(spaces, 'nadia'), []);
});

test('contacts page shows a Groups section with people count and activity time', () => {
  const markup = renderContactsPage([], { groupSpaces: [space()], onOpenGroup: () => undefined });
  assert.match(markup, /aria-label="Groups"/);
  assert.match(markup, />Poster session</);
  assert.match(markup, />2 people</);
  assert.match(markup, />09:41</);
});

test('contacts page hides Groups without groups or search matches', () => {
  assert.doesNotMatch(renderContactsPage([], { groupSpaces: [], onOpenGroup: () => undefined }), /aria-label="Groups"/);
  assert.doesNotMatch(
    renderContactsPage([], { groupSpaces: [space()], onOpenGroup: () => undefined, contactSearch: 'zzz' }),
    /aria-label="Groups"/,
  );
});
