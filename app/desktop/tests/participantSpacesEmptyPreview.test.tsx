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

test('buildParticipantSpaces does not expose raw session ids as participant-space previews', () => {
  const spaces = buildParticipantSpaces([
    conversation({
      id: 'session:raw-preview-group',
      canonicalSessionId: 'session:raw-preview-group',
      type: 'person',
      name: 'hi taylor',
      subtitle: 'session:bridge:humans:8e32e6b4-b8e7-4591-a412-8613ad09fe25',
      messages: [],
      participants: ['Me', 'member1', 'member2'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:member1', name: 'member1', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'member1' },
        { id: 'human:member2', name: 'member2', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'member2' },
      ],
    }),
  ]);

  assert.equal(spaces[0]?.preview, '');
  assert.equal(spaces[0]?.sessions[0]?.preview, '');
});

test('buildParticipantSpaces keeps the preview empty for a group with no messages even when the subtitle is an unusual id', () => {
  const spaces = buildParticipantSpaces([
    conversation({
      id: 'session:group:empty-preview',
      canonicalSessionId: 'session:group:empty-preview',
      type: 'group',
      name: 'Memory routing test',
      subtitle: 'memtest-group-5df0c05448fe',
      messages: [],
      participants: ['Me', 'member1', 'member2'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:member1', name: 'member1', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'member1' },
        { id: 'human:member2', name: 'member2', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'member2' },
      ],
    }),
  ]);

  assert.equal(spaces.length, 1);
  assert.equal(spaces[0]?.preview, '');
  assert.equal(spaces[0]?.sessions[0]?.preview, '');
});
