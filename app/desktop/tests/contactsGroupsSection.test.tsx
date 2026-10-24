import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  contactsGroupRows,
  visibleGroupRows,
} from '../src/kordi-app/contacts/contactsGroupRows';
import { isGroundingGroupSpace } from '../src/kordi-app/contacts/groundingGroup';
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
  assert.match(markup, />2 people · 09:41</);
  assert.doesNotMatch(markup, /title="Poster session"/);
  const solo = space({ participants: [{ id: 'me', name: 'Me', kind: 'human', role: 'self' }] as ParticipantSpaceViewModel['participants'] });
  assert.match(renderContactsPage([], { groupSpaces: [solo], onOpenGroup: () => undefined }), />1 person · 09:41</);
});

test('group rows show the human members\' avatars, not agents', () => {
  const members = space({
    avatarStack: [
      { kind: 'human', seed: 'maya' },
      { kind: 'agent', seed: 'helper' },
    ] as ParticipantSpaceViewModel['avatarStack'],
  });
  const markup = renderContactsPage([], { groupSpaces: [members], onOpenGroup: () => undefined });
  assert.match(markup, /aria-label="[^"]* avatar"/);
  assert.doesNotMatch(markup, /data-tone=/);
});

test('groups show five rows and a Show all button unless searching', () => {
  const rows = Array.from({ length: 7 }, (_, index) => index);
  assert.equal(visibleGroupRows(rows, '', false).length, 5);
  assert.equal(visibleGroupRows(rows, '', true).length, 7);
  assert.equal(visibleGroupRows(rows, 'p', false).length, 7);
  const spaces = rows.map((index) => space({ id: `group:${index}`, title: `Poster ${index}`, updatedAtMs: index }));
  const markup = renderContactsPage([], { groupSpaces: spaces, onOpenGroup: () => undefined });
  assert.equal(markup.match(/app-group-row/g)?.length, 5);
  assert.match(markup, />Show all 7</);
  const searched = renderContactsPage([], { groupSpaces: spaces, onOpenGroup: () => undefined, contactSearch: 'poster' });
  assert.equal(searched.match(/app-group-row/g)?.length, 7);
  assert.doesNotMatch(searched, /Show all/);
  assert.doesNotMatch(renderContactsPage([], { groupSpaces: spaces.slice(0, 5), onOpenGroup: () => undefined }), /Show all/);
});

test('contacts page hides Groups without groups or search matches', () => {
  assert.doesNotMatch(renderContactsPage([], { groupSpaces: [], onOpenGroup: () => undefined }), /aria-label="Groups"/);
  assert.doesNotMatch(
    renderContactsPage([], { groupSpaces: [space()], onOpenGroup: () => undefined, contactSearch: 'zzz' }),
    /aria-label="Groups"/,
  );
});

function groundingSessions(origin: unknown): ParticipantSpaceViewModel['sessions'] {
  return [
    { id: 'session-0', conversation: { metadata: {} } },
    { id: 'session-1', conversation: { metadata: { groupOrigin: origin } } },
  ] as unknown as ParticipantSpaceViewModel['sessions'];
}

test('only groups the server marked as Grounding get the hug icon', () => {
  const grounding = space({ id: 'group:grounding', title: 'Meetup', sessions: groundingSessions('grounding') });
  assert.equal(isGroundingGroupSpace(grounding), true);
  assert.equal(isGroundingGroupSpace(space({ sessions: groundingSessions('other') })), false);
  assert.equal(isGroundingGroupSpace(space()), false);
  const markup = renderContactsPage([], { groupSpaces: [grounding, space()], onOpenGroup: () => undefined });
  assert.equal(markup.match(/aria-label="Grounding"/g)?.length, 1);
  assert.doesNotMatch(renderContactsPage([], { groupSpaces: [space()], onOpenGroup: () => undefined }), /aria-label="Grounding"/);
});
