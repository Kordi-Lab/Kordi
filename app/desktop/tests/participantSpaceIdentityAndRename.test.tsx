import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildParticipantSpaces } from '../src/features/chat/participantSpaces';
import type { Conversation } from '../src/kordi-app/types';

type ConversationFixture = Conversation & { _updatedAtMs?: number };

function conversation(overrides: Partial<ConversationFixture> = {}): ConversationFixture {
  return {
    id: 'session:default',
    canonicalSessionId: 'session:default',
    name: 'Session',
    type: 'person',
    subtitle: 'Preview',
    unread: 0,
    collaborationSources: ['Bridge'],
    trust: 'Bridge',
    directness: 'Direct chat',
    participants: ['Me', 'Bob'],
    canonicalParticipants: [
      { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
      { id: 'human:bob', name: 'Bob', kind: 'human', role: 'delegate', source: 'bridge', avatarKey: 'bob' },
    ],
    messages: [{ role: 'person', sender: 'Bob', text: 'Preview', time: '10:00' }],
    updatedAtLabel: '10:00',
    _updatedAtMs: 1,
    ...overrides,
  };
}

test('buildParticipantSpaces previews a visible rename notice', () => {
  const spaces = buildParticipantSpaces([
    conversation({
      participantSpaceId: 'session:group:planning',
      messages: [
        { role: 'person', sender: 'Bob', text: 'Earlier message', time: '09:30' },
        {
          role: 'system',
          text: 'Alex changed the channel name to Planning',
          time: '09:41',
          messageKind: 'session-title-update',
        },
      ],
    }),
  ]);

  assert.equal(spaces[0]?.preview, 'Alex changed the channel name to Planning');
  assert.equal(spaces[0]?.sessions[0]?.preview, 'Alex changed the channel name to Planning');
});

test('buildParticipantSpaces keeps authoritative Cloud groups with the same members separate', () => {
  const participants = [
    { id: 'human:acct_me', name: 'Me', kind: 'human' as const, role: 'self', source: 'local' as const, humanId: 'acct_me', avatarKey: 'me' },
    { id: 'human:acct_peer', name: 'Peer', kind: 'human' as const, role: 'person', source: 'bridge' as const, humanId: 'acct_peer', sourceIdentityId: 'acct_peer', sourceHostId: 'cloud', avatarKey: 'peer' },
  ];
  const spaces = buildParticipantSpaces([
    conversation({
      id: 'session:group:first',
      canonicalSessionId: 'session:group:first',
      name: 'First group',
      directness: 'Group chat',
      participantSpaceId: 'group:session:group:first',
      metadata: { customName: 'First group', groupSpaceId: 'session:group:first' },
      canonicalParticipants: participants,
      _updatedAtMs: 1,
    }),
    conversation({
      id: 'session:group:second',
      canonicalSessionId: 'session:group:second',
      name: 'Second group',
      directness: 'Group chat',
      participantSpaceId: 'group:session:group:second',
      metadata: { customName: 'Second group', groupSpaceId: 'session:group:second' },
      canonicalParticipants: participants,
      _updatedAtMs: 2,
    }),
  ]);

  assert.deepEqual(spaces.map((space) => space.title), ['Second group', 'First group']);
  assert.deepEqual(spaces.map((space) => space.sessions.length), [1, 1]);
});
