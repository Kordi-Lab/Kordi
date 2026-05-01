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

test('buildParticipantSpaces separates direct human and self spaces on same Bridge node', () => {
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
    ['self:local', 'self', 'Myself'],
  ]);
});

test('buildParticipantSpaces infers a local owned-agent session as part of the self space without canonical participants', () => {
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
  assert.equal(spaces[0]?.id, 'self:local');
  assert.equal(spaces[0]?.kind, 'self');
  assert.equal(spaces[0]?.title, 'Myself');
  assert.deepEqual(spaces[0]?.avatarStack, [{ kind: 'human', seed: 'human-local', imageUrl: null }]);
});

test('buildParticipantSpaces keeps one human plus agents in a human-centered space', () => {
  const spaces = buildParticipantSpaces([
    conversation({
      id: 'session:shu-agent',
      canonicalSessionId: 'session:shu-agent',
      type: 'person',
      name: 'Agent-assisted chat with shu',
      subtitle: "shuhere2's Kordi joined via mention",
      participants: ['Me', 'shu', "shuhere2's Kordi"],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:shu', name: 'shu', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'shu' },
        { id: 'agent:shuhere2-kordi', name: "shuhere2's Kordi", kind: 'agent', role: 'delegate', source: 'bridge', ownerName: 'shuhere2', avatarKey: 'agent-shu' },
      ],
    }),
  ]);

  assert.equal(spaces.length, 1);
  assert.equal(spaces[0]?.id, 'direct-human:human:shu');
  assert.equal(spaces[0]?.kind, 'direct-human');
  assert.equal(spaces[0]?.title, 'shu');
  assert.equal(spaces[0]?.participantCount, 3);
  assert.deepEqual(spaces[0]?.avatarStack.map((avatar) => avatar.seed), ['shu']);
});

test('buildParticipantSpaces groups agent-only sessions into the default self space', () => {
  const spaces = buildParticipantSpaces([
    conversation({
      id: 'session:my-kordi',
      canonicalSessionId: 'session:my-kordi',
      type: 'owned-agent',
      name: 'Planning with My Kordi',
      participants: ['Me', 'My Kordi'],
      _updatedAtMs: 1,
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'agent:my-kordi', name: 'My Kordi', kind: 'agent', role: 'delegate', source: 'local', avatarKey: 'my-kordi' },
      ],
    }),
    conversation({
      id: 'session:any-agent',
      canonicalSessionId: 'session:any-agent',
      type: 'external-agent',
      name: 'Ask remote agent',
      participants: ['Me', 'Research Kordi'],
      _updatedAtMs: 3,
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'agent:research-kordi', name: 'Research Kordi', kind: 'agent', role: 'delegate', source: 'bridge', avatarKey: 'research-kordi' },
      ],
    }),
  ]);

  assert.equal(spaces.length, 1);
  assert.equal(spaces[0]?.id, 'self:local');
  assert.equal(spaces[0]?.kind, 'self');
  assert.equal(spaces[0]?.title, 'Myself');
  assert.equal(spaces[0]?.sessionCount, 2);
  assert.deepEqual(spaces[0]?.avatarStack.map((avatar) => avatar.seed), ['me']);
  assert.deepEqual(spaces[0]?.sessions.map((session) => session.id), ['session:any-agent', 'session:my-kordi']);
});

test('buildParticipantSpaces builds a true group when a conversation has multiple non-self humans', () => {
  const spaces = buildParticipantSpaces([
    conversation({
      id: 'session:design-group',
      canonicalSessionId: 'session:design-group',
      type: 'person',
      name: 'Kordi design group',
      subtitle: 'Planning sidebar IA',
      participants: ['Me', 'shu', 'Alex', "shuhere2's Kordi"],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:shu', name: 'shu', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'shu' },
        { id: 'human:alex', name: 'Alex', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alex' },
        { id: 'agent:shuhere2-kordi', name: "shuhere2's Kordi", kind: 'agent', role: 'delegate', source: 'bridge', ownerName: 'shuhere2', avatarKey: 'agent-shu' },
      ],
    }),
  ]);

  assert.equal(spaces.length, 1);
  assert.equal(spaces[0]?.kind, 'group');
  assert.equal(spaces[0]?.title, 'shu, Alex');
  assert.equal(spaces[0]?.participantCount, 4);
  assert.deepEqual(spaces[0]?.avatarStack.map((avatar) => avatar.seed), ['shu', 'alex']);
});

test('buildParticipantSpaces truncates long inferred group names with a remaining people count', () => {
  const humans = Array.from({ length: 105 }, (_, index) => ({
    id: `human:shuyhere${index + 1}`,
    name: `shuyhere${index + 1}`,
    kind: 'human' as const,
    role: 'person',
    source: 'bridge',
    avatarKey: `shuyhere${index + 1}`,
  }));
  const spaces = buildParticipantSpaces([
    conversation({
      id: 'session:large-group',
      canonicalSessionId: 'session:large-group',
      type: 'person',
      name: 'Large group thread',
      participants: ['Me', ...humans.map((participant) => participant.name), 'Helper Kordi'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        ...humans,
        { id: 'agent:helper-kordi', name: 'Helper Kordi', kind: 'agent', role: 'delegate', source: 'bridge', avatarKey: 'helper-kordi' },
      ],
    }),
  ]);

  assert.equal(spaces[0]?.title, 'shuyhere1, shuyhere2 +103 more');
  assert.deepEqual(spaces[0]?.avatarStack.map((avatar) => avatar.seed), ['shuyhere1', 'shuyhere2', 'shuyhere3', 'shuyhere4']);
});

test('buildParticipantSpaces does not expose raw session ids as participant-space previews', () => {
  const spaces = buildParticipantSpaces([
    conversation({
      id: 'session:raw-preview-group',
      canonicalSessionId: 'session:raw-preview-group',
      type: 'person',
      name: 'hi shu',
      subtitle: 'session:bridge:humans:8e32e6b4-b8e7-4591-a412-8613ad09fe25',
      messages: [],
      participants: ['Me', 'shuyhere1', 'shuyhere2'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:shuyhere1', name: 'shuyhere1', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'shuyhere1' },
        { id: 'human:shuyhere2', name: 'shuyhere2', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'shuyhere2' },
      ],
    }),
  ]);

  assert.equal(spaces[0]?.preview, 'hi shu');
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

test('filterParticipantSpaces applies chat filter tabs to human-centered spaces', () => {
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
      participants: ['Me', 'Bob', 'Alex', "Bob's Kordi"],
      _updatedAtMs: 1,
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
        { id: 'human:alex', name: 'Alex', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alex' },
        { id: 'agent:bob-kordi', name: "Bob's Kordi", kind: 'agent', role: 'delegate', source: 'bridge', avatarKey: 'agent-bob' },
      ],
    }),
  ]);

  assert.deepEqual(filterParticipantSpaces(spaces, '', 'people').map((space) => space.kind), ['direct-human', 'self']);
  assert.deepEqual(filterParticipantSpaces(spaces, '', 'agents').map((space) => space.kind), ['self']);
  assert.deepEqual(filterParticipantSpaces(spaces, '', 'delegated').map((space) => space.kind), ['group']);
  assert.equal(filterParticipantSpaces(spaces, 'design', 'people').length, 0);
});
