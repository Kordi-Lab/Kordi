import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildParticipantSpaces,
  filterParticipantSpaces,
} from '../src/features/chat/participantSpaces';
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
    bridges: ['Bridge'],
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

test('buildParticipantSpaces groups direct human sessions by participant identity', () => {
  const spaces = buildParticipantSpaces([
    conversation({
      id: 'session:bob:old',
      canonicalSessionId: 'session:bob:old',
      name: 'Old Bob thread',
      subtitle: 'old preview',
      unread: 1,
      updatedAtLabel: '09:00',
      _updatedAtMs: 1,
      messages: [{ role: 'person', sender: 'Bob', text: 'old preview', time: '09:00' }],
    }),
    conversation({
      id: 'session:bob:new',
      canonicalSessionId: 'session:bob:new',
      name: 'New Bob thread',
      subtitle: 'new preview',
      unread: 2,
      updatedAtLabel: '10:00',
      _updatedAtMs: 2,
      messages: [{ role: 'person', sender: 'Bob', text: 'new preview', time: '10:00' }],
    }),
  ]);

  assert.equal(spaces.length, 1);
  assert.equal(spaces[0]?.id, 'direct-human:human:bob');
  assert.equal(spaces[0]?.kind, 'direct-human');
  assert.equal(spaces[0]?.title, 'Bob');
  assert.equal(spaces[0]?.sessionCount, 2);
  assert.equal(spaces[0]?.unread, 3);
  assert.equal(spaces[0]?.preview, 'new preview');
  assert.deepEqual(spaces[0]?.avatarStack.map((avatar) => avatar.seed), ['bob']);
  assert.deepEqual(spaces[0]?.sessions.map((session) => session.id), ['session:bob:new', 'session:bob:old']);
});

test('buildParticipantSpaces separates direct human and direct agent spaces on same Bridge node', () => {
  const spaces = buildParticipantSpaces([
    conversation({
      id: 'session:bob-person',
      type: 'person',
      name: 'Bob',
      _updatedAtMs: 2,
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'delegate', source: 'bridge', bridgeNodeId: 'node-bob', avatarKey: 'bob' },
      ],
    }),
    conversation({
      id: 'session:bob-agent',
      type: 'external-agent',
      name: "Bob's Kordi",
      participants: ['Me', "Bob's Kordi"],
      _updatedAtMs: 1,
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'agent:bob-kordi', name: "Bob's Kordi", kind: 'agent', role: 'delegate', source: 'bridge', bridgeNodeId: 'node-bob', ownerName: 'Bob', avatarKey: 'agent-bob' },
      ],
    }),
  ]);

  assert.deepEqual(spaces.map((space) => [space.id, space.kind, space.title]), [
    ['direct-human:human:bob', 'direct-human', 'Bob'],
    ['direct-agent:agent:bob-kordi', 'direct-agent', "Bob's Kordi"],
  ]);
});

test('buildParticipantSpaces infers a local owned-agent direct space without canonical participants', () => {
  const spaces = buildParticipantSpaces([
    conversation({
      id: 'session:local-agent',
      canonicalSessionId: 'session:local-agent',
      type: 'owned-agent',
      name: 'Local planning',
      participants: ['Me', 'My Kordi'],
      participantAvatarSeeds: {
        Me: 'human-local',
        'My Kordi': 'agent-local',
      },
      avatarSeed: 'agent-local',
      canonicalParticipants: undefined,
    }),
  ]);

  assert.equal(spaces.length, 1);
  assert.equal(spaces[0]?.id, 'direct-agent:label:agent:My Kordi');
  assert.equal(spaces[0]?.kind, 'direct-agent');
  assert.equal(spaces[0]?.title, 'My Kordi');
  assert.deepEqual(spaces[0]?.avatarStack, [{ kind: 'agent', seed: 'agent-local', imageUrl: null }]);
});

test('buildParticipantSpaces builds a group space when a conversation has multiple non-self participants', () => {
  const spaces = buildParticipantSpaces([
    conversation({
      id: 'session:design-group',
      canonicalSessionId: 'session:design-group',
      type: 'person',
      name: 'Kordi design group',
      subtitle: 'Planning sidebar IA',
      participants: ['Me', 'Bob', "Bob's Kordi"],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
        { id: 'agent:bob-kordi', name: "Bob's Kordi", kind: 'agent', role: 'delegate', source: 'bridge', ownerName: 'Bob', avatarKey: 'agent-bob' },
      ],
    }),
  ]);

  assert.equal(spaces.length, 1);
  assert.equal(spaces[0]?.kind, 'group');
  assert.equal(spaces[0]?.title, 'Kordi design group');
  assert.equal(spaces[0]?.participantCount, 3);
  assert.deepEqual(spaces[0]?.avatarStack.map((avatar) => avatar.seed), ['me', 'bob', 'agent-bob']);
});

test('filterParticipantSpaces matches title, participant names, preview, and child session title', () => {
  const spaces = buildParticipantSpaces([
    conversation({
      id: 'session:bob',
      name: 'New Bob thread',
      subtitle: 'Budget question',
      messages: [{ role: 'person', sender: 'Bob', text: 'Budget question', time: '10:00' }],
    }),
  ]);

  assert.equal(filterParticipantSpaces(spaces, 'bob').length, 1);
  assert.equal(filterParticipantSpaces(spaces, 'budget').length, 1);
  assert.equal(filterParticipantSpaces(spaces, 'missing').length, 0);
});

test('filterParticipantSpaces applies chat filter tabs to spaces', () => {
  const spaces = buildParticipantSpaces([
    conversation({
      id: 'session:bob-person',
      type: 'person',
      name: 'Bob',
      _updatedAtMs: 3,
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'delegate', source: 'bridge', avatarKey: 'bob' },
      ],
    }),
    conversation({
      id: 'session:bob-agent',
      type: 'external-agent',
      name: "Bob's Kordi",
      participants: ['Me', "Bob's Kordi"],
      _updatedAtMs: 2,
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'agent:bob-kordi', name: "Bob's Kordi", kind: 'agent', role: 'delegate', source: 'bridge', avatarKey: 'agent-bob' },
      ],
    }),
    conversation({
      id: 'session:design-group',
      type: 'person',
      name: 'Design group',
      participants: ['Me', 'Bob', "Bob's Kordi"],
      _updatedAtMs: 1,
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
        { id: 'agent:bob-kordi', name: "Bob's Kordi", kind: 'agent', role: 'delegate', source: 'bridge', avatarKey: 'agent-bob' },
      ],
    }),
  ]);

  assert.deepEqual(filterParticipantSpaces(spaces, '', 'people').map((space) => space.kind), ['direct-human']);
  assert.deepEqual(filterParticipantSpaces(spaces, '', 'agents').map((space) => space.kind), ['direct-agent']);
  assert.deepEqual(filterParticipantSpaces(spaces, '', 'delegated').map((space) => space.kind), ['group']);
  assert.equal(filterParticipantSpaces(spaces, 'design', 'people').length, 0);
});
