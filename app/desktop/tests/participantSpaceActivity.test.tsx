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

test('participant-space previews ignore newer membership notices', () => {
  const spaces = buildParticipantSpaces([
    conversation({
      id: 'session:group:preview',
      canonicalSessionId: 'session:group:preview',
      type: 'person',
      _updatedAtMs: Date.parse('2018-07-17T18:56:00Z'),
      updatedAtLabel: '18:56',
      messages: [
        {
          role: 'person',
          sender: 'Bob',
          text: 'Latest chat message',
          time: '18:46',
          timestampMs: Date.parse('2017-07-17T18:46:00Z'),
        },
        {
          role: 'system',
          text: 'Someone joined the group.',
          time: '18:56',
          timestampMs: Date.parse('2018-07-17T18:56:00Z'),
        },
      ],
    }),
  ]);

  assert.equal(spaces[0]?.sessions[0]?.preview, 'Latest chat message');
  assert.equal(spaces[0]?.sessions[0]?.updatedAtLabel, '18:56');
  assert.equal(
    spaces[0]?.sessions[0]?.updatedAtMs,
    Date.parse('2018-07-17T18:56:00Z'),
  );
});

test('group activity uses the newest child while preview uses the newest real message', () => {
  const spaces = buildParticipantSpaces([
    conversation({
      id: 'session:group:message',
      canonicalSessionId: 'session:group:message',
      participantSpaceId: 'group:shared',
      name: 'Austin life',
      _updatedAtMs: Date.parse('2017-07-17T18:46:00Z'),
      messages: [{
        role: 'person',
        sender: 'Bob',
        text: 'Latest real message',
        time: '18:46',
        timestampMs: Date.parse('2017-07-17T18:46:00Z'),
      }],
    }),
    conversation({
      id: 'session:group:activity',
      canonicalSessionId: 'session:group:activity',
      participantSpaceId: 'group:shared',
      name: 'General Chat',
      subtitle: 'General Chat',
      updatedAtLabel: '17/07/2018',
      _updatedAtMs: Date.parse('2018-07-17T18:56:00Z'),
      messages: [{
        role: 'system',
        text: 'Someone joined the group.',
        time: '18:56',
        timestampMs: Date.parse('2018-07-17T18:56:00Z'),
      }],
    }),
  ]);

  assert.equal(spaces[0]?.updatedAtMs, Date.parse('2018-07-17T18:56:00Z'));
  assert.equal(spaces[0]?.updatedAtLabel, '17/07/2018');
  assert.equal(spaces[0]?.preview, 'Latest real message');
  assert.deepEqual(
    spaces[0]?.sessions.map((session) => session.id),
    ['session:group:activity', 'session:group:message'],
  );
});
