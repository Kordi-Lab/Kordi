import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildParticipantSpaces,
  ensureSelfParticipantSpace,
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

test('buildParticipantSpaces previews latest agent response when message text is empty', () => {
  const spaces = buildParticipantSpaces([
    conversation({
      id: 'session:bob-agent-reply',
      canonicalSessionId: 'session:bob-agent-reply',
      subtitle: 'Bob',
      messages: [{
        role: 'owned-agent',
        sender: 'My Kordi',
        text: '',
        time: '10:01',
        turn: {
          id: 'turn-1',
          sessionId: 'session:bob-agent-reply',
          prompt: 'how are you',
          status: 'completed',
          message: '',
          assistantText: 'I’m doing well — thanks for asking.',
          thinkingText: '',
          tools: [],
          completed: true,
          succeeded: true,
        },
      }],
    }),
  ]);

  assert.equal(spaces[0]?.preview, 'I’m doing well — thanks for asking.');
  assert.equal(spaces[0]?.sessions[0]?.preview, 'I’m doing well — thanks for asking.');
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
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'delegate', source: 'bridge', sourceIdentityId: 'node-bob', avatarKey: 'bob' },
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
        { id: 'agent:bob-kordi', name: "Bob's Kordi", kind: 'agent', role: 'delegate', source: 'bridge', sourceIdentityId: 'node-bob', ownerName: 'Bob', avatarKey: 'agent-bob' },
      ],
    }),
  ]);

  assert.deepEqual(spaces.map((space) => [space.id, space.kind, space.title]), [
    ['direct-human:human:bob', 'direct-human', 'Bob'],
    ['self:local', 'self', 'My chats'],
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
  assert.equal(spaces[0]?.title, 'My chats');
  assert.deepEqual(spaces[0]?.avatarStack, [{ kind: 'human', seed: 'human-local', isSelf: true, imageUrl: null, presenceStatus: null }]);
});

test('buildParticipantSpaces keeps one human plus agents in a human-centered space', () => {
  const spaces = buildParticipantSpaces([
    conversation({
      id: 'session:taylor-agent',
      canonicalSessionId: 'session:taylor-agent',
      type: 'person',
      name: 'Agent-assisted chat with taylor',
      subtitle: "taylor2's Kordi joined via mention",
      participants: ['Me', 'taylor', "taylor2's Kordi"],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:taylor', name: 'taylor', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'taylor' },
        { id: 'agent:taylor2-kordi', name: "taylor2's Kordi", kind: 'agent', role: 'delegate', source: 'bridge', ownerName: 'taylor2', avatarKey: 'agent-taylor' },
      ],
    }),
  ]);

  assert.equal(spaces.length, 1);
  assert.equal(spaces[0]?.id, 'direct-human:human:taylor');
  assert.equal(spaces[0]?.kind, 'direct-human');
  assert.equal(spaces[0]?.title, 'taylor');
  assert.equal(spaces[0]?.participantCount, 3);
  assert.deepEqual(spaces[0]?.avatarStack.map((avatar) => avatar.seed), ['taylor']);
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
  assert.equal(spaces[0]?.title, 'My chats');
  assert.equal(spaces[0]?.sessionCount, 2);
  assert.deepEqual(spaces[0]?.avatarStack.map((avatar) => avatar.seed), ['me']);
  assert.deepEqual(spaces[0]?.sessions.map((session) => session.id), ['session:any-agent', 'session:my-kordi']);
});

test('buildParticipantSpaces folds generic bridge group continuations into the named group with the same people', () => {
  const participants = [
    { id: 'human:me', name: 'Me', kind: 'human' as const, role: 'self', source: 'local' as const, avatarKey: 'me' },
    { id: 'human:alice', name: 'Alice', kind: 'human' as const, role: 'person', source: 'bridge' as const, avatarKey: 'alice' },
    { id: 'human:bob', name: 'Bob', kind: 'human' as const, role: 'person', source: 'bridge' as const, avatarKey: 'bob' },
  ];
  const spaces = buildParticipantSpaces([
    conversation({
      id: 'session:group:root',
      canonicalSessionId: 'session:group:root',
      name: 'Codex learning',
      type: 'owned-agent',
      directness: 'Group chat',
      participantSpaceId: 'group:session:group:root',
      canonicalParticipants: participants,
      metadata: { customName: 'Codex learning', groupSpaceId: 'session:group:root' },
      _updatedAtMs: 1,
    }),
    conversation({
      id: 'session:group:child',
      canonicalSessionId: 'session:group:child',
      name: 'Group',
      type: 'owned-agent',
      directness: 'Group chat',
      participantSpaceId: 'group:session:group:child',
      canonicalParticipants: participants,
      metadata: { source: 'bridge-session-thread', groupSpaceId: 'session:group:child' },
      _updatedAtMs: 2,
    }),
  ]);

  assert.equal(spaces.length, 1);
  assert.equal(spaces[0]?.id, 'group:session:group:root');
  assert.equal(spaces[0]?.title, 'Codex learning');
  assert.deepEqual(spaces[0]?.sessions.map((session) => session.canonicalSessionId), ['session:group:child', 'session:group:root']);
});

test('buildParticipantSpaces builds a true group when a conversation has multiple non-self humans', () => {
  const spaces = buildParticipantSpaces([
    conversation({
      id: 'session:design-group',
      canonicalSessionId: 'session:design-group',
      type: 'person',
      name: 'Kordi design group',
      subtitle: 'Planning sidebar IA',
      metadata: { groupCreatorIdentityId: 'human:me' },
      participants: ['Me', 'taylor', 'Alex', "taylor2's Kordi"],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:taylor', name: 'taylor', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'taylor' },
        { id: 'human:alex', name: 'Alex', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alex' },
        { id: 'agent:taylor2-kordi', name: "taylor2's Kordi", kind: 'agent', role: 'delegate', source: 'bridge', ownerName: 'taylor2', avatarKey: 'agent-taylor' },
      ],
    }),
  ]);

  assert.equal(spaces.length, 1);
  assert.equal(spaces[0]?.kind, 'group');
  assert.equal(spaces[0]?.title, 'Alex, taylor');
  assert.equal(spaces[0]?.participantCount, 4);
  assert.deepEqual(spaces[0]?.avatarStack.map((avatar) => avatar.seed), ['alex', 'me', 'taylor']);
});

test('buildParticipantSpaces collapses duplicate blank sessions in a participant space', () => {
  const spaces = buildParticipantSpaces([
    conversation({
      id: 'session:bridge:humans:blank-newer',
      canonicalSessionId: 'session:bridge:humans:blank-newer',
      name: 'New session',
      subtitle: 'New session',
      messages: [],
      canonicalMessageCount: 0,
      updatedAtLabel: '13:19',
      _updatedAtMs: 4,
    }),
    conversation({
      id: 'session:direct-human:legacy-blank',
      canonicalSessionId: 'session:direct-human:legacy-blank',
      name: 'New session',
      subtitle: 'Session ready',
      messages: [{ role: 'system', text: 'Session ready', time: '13:18' }],
      canonicalMessageCount: 0,
      updatedAtLabel: '13:18',
      _updatedAtMs: 3,
    }),
    conversation({
      id: 'session:bridge:humans:real-thread',
      canonicalSessionId: 'session:bridge:humans:real-thread',
      name: 'Release plan',
      subtitle: 'Ship it',
      messages: [{ role: 'person', sender: 'Bob', text: 'Ship it', time: '13:17' }],
      canonicalMessageCount: 1,
      updatedAtLabel: '13:17',
      _updatedAtMs: 2,
    }),
    conversation({
      id: 'session:bridge:humans:blank-older',
      canonicalSessionId: 'session:bridge:humans:blank-older',
      name: 'New session',
      subtitle: 'New session',
      messages: [],
      canonicalMessageCount: 0,
      updatedAtLabel: '13:16',
      _updatedAtMs: 1,
    }),
  ]);

  assert.equal(spaces.length, 1);
  assert.equal(spaces[0]?.sessionCount, 2);
  assert.deepEqual(spaces[0]?.sessions.map((session) => session.id), [
    'session:bridge:humans:blank-newer',
    'session:bridge:humans:real-thread',
  ]);
});

test('buildParticipantSpaces hides persisted empty group continuations but keeps the local draft', () => {
  const canonicalParticipants = [
    { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
    { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice' },
    { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
  ];
  const shared = {
    type: 'person' as const,
    participants: ['Me', 'Alice', 'Bob'],
    canonicalParticipants,
    participantSpaceId: 'group:session:group:root',
    directness: 'Group chat',
  };
  const spaces = buildParticipantSpaces([
    conversation({
      ...shared,
      id: 'session:group:root',
      canonicalSessionId: 'session:group:root',
      name: 'main',
      subtitle: 'Hello',
      messages: [{ role: 'person', sender: 'Alice', text: 'Hello', time: '10:00' }],
      canonicalMessageCount: 1,
      metadata: { groupId: 'session:group:root', groupSpaceId: 'session:group:root' },
      _updatedAtMs: 1,
    }),
    conversation({
      ...shared,
      id: 'session:group:legacy-empty',
      canonicalSessionId: 'session:group:legacy-empty',
      name: 'New chat',
      subtitle: 'New chat',
      messages: [],
      canonicalMessageCount: 0,
      participants: ['Me', 'Alice', 'Bob', 'Chen'],
      canonicalParticipants: [
        ...canonicalParticipants,
        { id: 'human:chen', name: 'Chen', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'chen' },
      ],
      metadata: { createdFrom: 'cloud-group-sync', groupId: 'session:group:root', groupSpaceId: 'session:group:root' },
      _updatedAtMs: 2,
    }),
    conversation({
      ...shared,
      id: 'session:group:local-draft',
      transientDraft: true,
      canonicalSessionId: 'session:group:local-draft',
      name: 'New session',
      subtitle: '',
      messages: [],
      canonicalMessageCount: 0,
      metadata: { createdFrom: 'chat-create-flow', groupId: 'session:group:root', groupSpaceId: 'session:group:root' },
      _updatedAtMs: 3,
    }),
  ]);

  assert.equal(spaces.length, 1);
  assert.deepEqual(spaces[0]?.sessions.map((session) => session.id), [
    'session:group:local-draft',
    'session:group:root',
  ]);
  assert.deepEqual(spaces[0]?.membershipSessionIds, [
    'session:group:legacy-empty',
    'session:group:root',
  ]);
  assert.ok(spaces[0]?.participants.some((participant) => participant.id === 'human:chen'));
});

test('buildParticipantSpaces collapses duplicate blank selected-agent sessions by agent', () => {
  const spaces = buildParticipantSpaces([
    conversation({
      id: 'session:self-agent:kordi-newer',
      canonicalSessionId: 'session:self-agent:kordi-newer',
      type: 'owned-agent',
      name: 'Kordi',
      subtitle: 'Kordi · 0 messages',
      participants: ['Me', 'Kordi'],
      messages: [],
      canonicalMessageCount: 0,
      metadata: { createdFrom: 'chat-create-flow', agentId: 'agent:kordi', participantSpaceKind: 'self' },
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'agent:kordi', name: 'Kordi', kind: 'agent', role: 'delegate', source: 'local', avatarKey: 'kordi' },
      ],
      _updatedAtMs: 4,
    }),
    conversation({
      id: 'session:self-agent:reviewer-blank',
      canonicalSessionId: 'session:self-agent:reviewer-blank',
      type: 'owned-agent',
      name: 'Reviewer',
      subtitle: 'Reviewer · 0 messages',
      participants: ['Me', 'Reviewer'],
      messages: [],
      canonicalMessageCount: 0,
      metadata: { createdFrom: 'chat-create-flow', agentId: 'agent:reviewer', participantSpaceKind: 'self' },
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'agent:reviewer', name: 'Reviewer', kind: 'agent', role: 'delegate', source: 'local', avatarKey: 'reviewer' },
      ],
      _updatedAtMs: 3,
    }),
    conversation({
      id: 'session:self-agent:kordi-older',
      canonicalSessionId: 'session:self-agent:kordi-older',
      type: 'owned-agent',
      name: 'Kordi',
      subtitle: 'Kordi · 0 messages',
      participants: ['Me', 'Kordi'],
      messages: [],
      canonicalMessageCount: 0,
      metadata: { createdFrom: 'chat-create-flow', agentId: 'agent:kordi', participantSpaceKind: 'self' },
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'agent:kordi', name: 'Kordi', kind: 'agent', role: 'delegate', source: 'local', avatarKey: 'kordi' },
      ],
      _updatedAtMs: 2,
    }),
    conversation({
      id: 'session:self-agent:kordi-real',
      canonicalSessionId: 'session:self-agent:kordi-real',
      type: 'owned-agent',
      name: 'Kordi',
      subtitle: 'Need help',
      participants: ['Me', 'Kordi'],
      messages: [{ role: 'person', sender: 'Me', text: 'Need help', time: '10:00' }],
      canonicalMessageCount: 1,
      metadata: { createdFrom: 'chat-create-flow', agentId: 'agent:kordi', participantSpaceKind: 'self' },
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'agent:kordi', name: 'Kordi', kind: 'agent', role: 'delegate', source: 'local', avatarKey: 'kordi' },
      ],
      _updatedAtMs: 1,
    }),
  ]);

  assert.equal(spaces.length, 1);
  assert.equal(spaces[0]?.sessionCount, 3);
  assert.deepEqual(spaces[0]?.sessions.map((session) => session.id), [
    'session:self-agent:kordi-newer',
    'session:self-agent:reviewer-blank',
    'session:self-agent:kordi-real',
  ]);
});

test('buildParticipantSpaces uses explicit custom group names before inferred people names', () => {
  const spaces = buildParticipantSpaces([
    conversation({
      id: 'session:my-group',
      canonicalSessionId: 'session:my-group',
      type: 'person',
      name: 'My group',
      participants: ['Me', 'Alice', 'Bob'],
      metadata: { customName: 'My group' },
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice' },
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
      ],
    }),
  ]);

  assert.equal(spaces[0]?.kind, 'group');
  assert.equal(spaces[0]?.title, 'My group');
});

test('buildParticipantSpaces prefers the canonical root name over a newer stale child variant', () => {
  const participants = [
    { id: 'human:me', name: 'Alex Morgan', kind: 'human' as const, role: 'self', source: 'local' as const, avatarKey: 'me' },
    { id: 'human:alice', name: 'Alice', kind: 'human' as const, role: 'person', source: 'bridge' as const, avatarKey: 'alice' },
    { id: 'human:bob', name: 'Bob', kind: 'human' as const, role: 'person', source: 'bridge' as const, avatarKey: 'bob' },
  ];
  const spaces = buildParticipantSpaces([
    conversation({
      id: 'session:group:root',
      canonicalSessionId: 'session:group:root',
      type: 'person',
      name: 'main',
      metadata: { customName: 'Shared group name', groupSpaceId: 'session:group:root' },
      participants: participants.map((participant) => participant.name),
      canonicalParticipants: participants,
      _updatedAtMs: 1,
    }),
    conversation({
      id: 'session:group:child',
      canonicalSessionId: 'session:group:child',
      type: 'person',
      name: 'Latest chat',
      metadata: { customName: 'Viewer-local stale name', groupSpaceId: 'session:group:root' },
      participants: participants.map((participant) => participant.name),
      canonicalParticipants: participants,
      _updatedAtMs: 2,
    }),
  ]);

  assert.equal(spaces[0]?.title, 'Shared group name');
});

test('buildParticipantSpaces applies the latest replicated group rename independently of child activity', () => {
  const participants = [
    { id: 'human:me', name: 'Alex Morgan', kind: 'human' as const, role: 'self', source: 'local' as const, avatarKey: 'me' },
    { id: 'human:alice', name: 'Alice', kind: 'human' as const, role: 'person', source: 'bridge' as const, avatarKey: 'alice' },
    { id: 'human:bob', name: 'Bob', kind: 'human' as const, role: 'person', source: 'bridge' as const, avatarKey: 'bob' },
  ];
  const spaces = buildParticipantSpaces([
    conversation({
      id: 'session:group:root',
      canonicalSessionId: 'session:group:root',
      type: 'person',
      name: 'main',
      metadata: { customName: 'Old name', groupSpaceId: 'session:group:root', groupNameUpdatedAtMs: 100 },
      participants: participants.map((participant) => participant.name),
      canonicalParticipants: participants,
      _updatedAtMs: 3,
    }),
    conversation({
      id: 'session:group:child',
      canonicalSessionId: 'session:group:child',
      type: 'person',
      name: 'Older chat',
      metadata: { customName: 'Renamed everywhere', groupSpaceId: 'session:group:root', groupNameUpdatedAtMs: 200 },
      participants: participants.map((participant) => participant.name),
      canonicalParticipants: participants,
      _updatedAtMs: 1,
    }),
  ]);

  assert.equal(spaces[0]?.title, 'Renamed everywhere');
});

test('buildParticipantSpaces infers the same group name for every viewer', () => {
  const members = [
    { id: 'human:acct_creator', name: 'Maya Chen', avatarKey: 'maya' },
    { id: 'human:acct_fish', name: 'Research Agent', avatarKey: 'fish' },
    { id: 'human:acct_ethan', name: 'Ethan Park', avatarKey: 'ethan' },
    { id: 'human:acct_alex', name: 'Alex Morgan', avatarKey: 'alex' },
  ];
  const buildForViewer = (viewerId: string, order: number[]) => buildParticipantSpaces([
    conversation({
      id: 'session:group:root',
      canonicalSessionId: 'session:group:root',
      type: 'person',
      name: 'main',
      metadata: { groupSpaceId: 'session:group:root', groupCreatorIdentityId: 'human:acct_creator' },
      participants: order.map((index) => members[index].name),
      canonicalParticipants: order.map((index) => {
        const member = members[index];
        const isSelf = member.id === viewerId;
        return {
          ...member,
          name: isSelf ? 'Me' : member.name,
          publicName: member.name,
          kind: 'human' as const,
          role: isSelf ? 'self' : 'person',
          source: isSelf ? 'local' as const : 'bridge' as const,
        };
      }),
    }),
  ])[0]?.title;

  const creatorView = buildForViewer('human:acct_creator', [0, 1, 2, 3]);
  const invitedMemberView = buildForViewer('human:acct_alex', [3, 2, 0, 1]);

  assert.equal(creatorView, 'Alex Morgan, Ethan Park +1 more');
  assert.equal(invitedMemberView, creatorView);
});

test('buildParticipantSpaces ignores generic new-session metadata name when preserving shared group name', () => {
  const spaces = buildParticipantSpaces([
    conversation({
      id: 'session:group:latest',
      canonicalSessionId: 'session:group:latest',
      type: 'person',
      name: 'New session',
      metadata: { customName: 'New session', groupId: 'session:group:latest', groupSpaceId: 'session:group:root' },
      participants: ['Me', 'Alice', 'Bob'],
      _updatedAtMs: 2,
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice' },
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
      ],
    }),
    conversation({
      id: 'session:group:root',
      canonicalSessionId: 'session:group:root',
      type: 'person',
      name: '1111',
      metadata: { customName: '1111', groupId: 'session:group:root', groupSpaceId: 'session:group:root' },
      participants: ['Me', 'Alice', 'Bob'],
      _updatedAtMs: 1,
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice' },
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
      ],
    }),
  ]);

  assert.equal(spaces[0]?.title, '1111');
});

test('buildParticipantSpaces merges profile image urls for duplicate group participants', () => {
  const spaces = buildParticipantSpaces([
    conversation({
      id: 'session:group:latest',
      canonicalSessionId: 'session:group:latest',
      type: 'person',
      name: 'Design crew',
      metadata: { customName: 'Design crew', groupSpaceId: 'session:group:root' },
      participants: ['Me', 'Alice', 'Bob'],
      _updatedAtMs: 2,
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice', humanId: 'acct_alice', profileImageUrl: null },
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
      ],
    }),
    conversation({
      id: 'session:group:root',
      canonicalSessionId: 'session:group:root',
      type: 'person',
      name: 'Design crew',
      metadata: { customName: 'Design crew', groupSpaceId: 'session:group:root' },
      participants: ['Me', 'Alice', 'Bob'],
      _updatedAtMs: 1,
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice', humanId: 'acct_alice', profileImageUrl: 'https://images.test/alice.png' },
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
      ],
    }),
  ]);

  assert.equal(spaces[0]?.avatarStack.find((avatar) => avatar.seed === 'alice')?.imageUrl, 'https://images.test/alice.png');
});

test('buildParticipantSpaces uses shared custom group name even when latest session lacks metadata name', () => {
  const spaces = buildParticipantSpaces([
    conversation({
      id: 'session:group:root',
      canonicalSessionId: 'session:group:root',
      type: 'person',
      name: 'Renamed group',
      metadata: { customName: 'Renamed group', groupId: 'session:group:root', groupSpaceId: 'session:group:root' },
      participants: ['Me', 'Alice', 'Bob'],
      _updatedAtMs: 1,
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice' },
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
      ],
    }),
    conversation({
      id: 'session:group:latest',
      canonicalSessionId: 'session:group:latest',
      type: 'person',
      name: 'hi every one',
      metadata: { groupId: 'session:group:root', groupSpaceId: 'session:group:root' },
      participants: ['Me', 'Alice', 'Bob'],
      _updatedAtMs: 2,
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice' },
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
      ],
    }),
  ]);

  assert.equal(spaces[0]?.title, 'Renamed group');
});

test('buildParticipantSpaces keeps a stable group space when invited members change participants', () => {
  const spaces = buildParticipantSpaces([
    conversation({
      id: 'session:group:root',
      canonicalSessionId: 'session:group:root',
      type: 'person',
      name: 'Kickoff',
      metadata: { customName: 'Design crew', groupSpaceId: 'session:group:root' },
      participants: ['Me', 'Alice', 'Bob'],
      _updatedAtMs: 1,
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice' },
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
      ],
    }),
    conversation({
      id: 'session:group:followup',
      canonicalSessionId: 'session:group:followup',
      type: 'person',
      name: 'Follow-up',
      metadata: { customName: 'Design crew', groupSpaceId: 'session:group:root' },
      participants: ['Me', 'Alice', 'Bob', 'Chen'],
      _updatedAtMs: 2,
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice' },
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
        { id: 'human:chen', name: 'Chen', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'chen' },
      ],
    }),
  ]);

  assert.equal(spaces.length, 1);
  assert.equal(spaces[0]?.id, 'group:session:group:root');
  assert.equal(spaces[0]?.title, 'Design crew');
  assert.equal(spaces[0]?.sessionCount, 2);
  assert.deepEqual(spaces[0]?.participants.map((participant) => participant.id), [
    'human:me',
    'human:alice',
    'human:bob',
    'human:chen',
  ]);
});

test('buildParticipantSpaces uses the authoritative group id when Cloud membership changes', () => {
  const self = { id: 'human:acct_self', name: 'Me', kind: 'human' as const, role: 'self', source: 'local' as const, humanId: 'acct_self', avatarKey: 'me' };
  const alice = { id: 'human:acct_alice', name: 'Alice', kind: 'human' as const, role: 'person', source: 'bridge' as const, humanId: 'acct_alice', sourceIdentityId: 'acct_alice', sourceHostId: 'cloud', avatarKey: 'alice' };
  const bob = { id: 'human:acct_bob', name: 'Bob', kind: 'human' as const, role: 'person', source: 'bridge' as const, humanId: 'acct_bob', sourceIdentityId: 'acct_bob', sourceHostId: 'cloud', avatarKey: 'bob' };
  const spaces = buildParticipantSpaces([
    conversation({
      id: 'session:group:cloud-root',
      canonicalSessionId: 'session:group:cloud-root',
      name: 'Cloud group',
      participantSpaceId: 'group:session:group:cloud-root',
      metadata: { customName: 'Cloud group', groupSpaceId: 'session:group:cloud-root' },
      canonicalParticipants: [self, alice],
      participants: ['Me', 'Alice'],
      _updatedAtMs: 1,
    }),
    conversation({
      id: 'session:group:cloud-followup',
      canonicalSessionId: 'session:group:cloud-followup',
      name: 'Follow-up',
      participantSpaceId: 'group:session:group:cloud-root',
      metadata: { customName: 'Cloud group', groupSpaceId: 'session:group:cloud-root' },
      canonicalParticipants: [self, alice, bob],
      participants: ['Me', 'Alice', 'Bob'],
      _updatedAtMs: 2,
    }),
  ]);

  assert.equal(spaces.length, 1);
  assert.equal(spaces[0]?.id, 'group:session:group:cloud-root');
  assert.deepEqual(spaces[0]?.participants.map((participant) => participant.id), [
    'human:acct_self',
    'human:acct_alice',
    'human:acct_bob',
  ]);
});

test('buildParticipantSpaces keeps legacy continued group sessions in their original group after invites', () => {
  const spaces = buildParticipantSpaces([
    conversation({
      id: 'session:group:legacy-root',
      canonicalSessionId: 'session:group:legacy-root',
      type: 'person',
      name: 'Kickoff',
      metadata: { customName: 'Design crew' },
      participants: ['Me', 'Alice', 'Bob'],
      _updatedAtMs: 1,
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice' },
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
      ],
    }),
    conversation({
      id: 'session:group:legacy-followup',
      canonicalSessionId: 'session:group:legacy-followup',
      type: 'person',
      name: 'Follow-up',
      metadata: { customName: 'Design crew', continuedFromSpaceId: 'group:human:alice+human:bob' },
      participants: ['Me', 'Alice', 'Bob', 'Chen'],
      _updatedAtMs: 2,
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice' },
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
        { id: 'human:chen', name: 'Chen', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'chen' },
      ],
    }),
  ]);

  assert.equal(spaces.length, 1);
  assert.equal(spaces[0]?.id, 'group:human:alice+human:bob');
  assert.equal(spaces[0]?.sessionCount, 2);
  assert.deepEqual(spaces[0]?.sessions.map((session) => session.id), [
    'session:group:legacy-followup',
    'session:group:legacy-root',
  ]);
});

test('buildParticipantSpaces truncates long inferred group names with a remaining people count', () => {
  const humans = Array.from({ length: 105 }, (_, index) => ({
    id: `human:member${index + 1}`,
    name: `member${index + 1}`,
    kind: 'human' as const,
    role: 'person',
    source: 'bridge',
    avatarKey: `member${index + 1}`,
  }));
  const spaces = buildParticipantSpaces([
    conversation({
      id: 'session:large-group',
      canonicalSessionId: 'session:large-group',
      type: 'person',
      name: 'Large group thread',
      metadata: { groupCreatorIdentityId: 'human:me' },
      participants: ['Me', ...humans.map((participant) => participant.name), 'Helper Kordi'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        ...humans,
        { id: 'agent:helper-kordi', name: 'Helper Kordi', kind: 'agent', role: 'delegate', source: 'bridge', avatarKey: 'helper-kordi' },
      ],
    }),
  ]);

  assert.equal(spaces[0]?.title, 'member1, member2 +103 more');
  assert.deepEqual(spaces[0]?.avatarStack.map((avatar) => avatar.seed), ['me', 'member1', 'member10']);
});

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

  assert.equal(spaces[0]?.preview, 'hi taylor');
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

  assert.equal(filterParticipantSpaces(spaces, 'bob', 'contact').length, 1);
  assert.equal(filterParticipantSpaces(spaces, 'budget', 'contact').length, 1);
  assert.equal(filterParticipantSpaces(spaces, 'missing', 'contact').length, 0);
});

test('ensureSelfParticipantSpace adds My chats as a pinned contact when no self sessions exist', () => {
  const spaces = ensureSelfParticipantSpace(buildParticipantSpaces([
    conversation({
      id: 'session:bob-person',
      type: 'person',
      name: 'Bob',
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'delegate', source: 'bridge', avatarKey: 'bob' },
      ],
    }),
  ]), { avatarSeed: 'local-me' });

  const selfSpace = spaces.find((space) => space.kind === 'self');
  assert.equal(selfSpace?.title, 'My chats');
  assert.equal(selfSpace?.sessionCount, 0);
  assert.deepEqual(selfSpace?.avatarStack, [{ kind: 'human', seed: 'local-me', isSelf: true, imageUrl: null }]);
  assert.deepEqual(filterParticipantSpaces(spaces, '', 'contact').map((space) => space.title), ['Bob']);
  assert.deepEqual(filterParticipantSpaces(spaces, '', 'agent').map((space) => space.title), ['My chats']);
});

test('filterParticipantSpaces splits spaces into Contact and Agent channels', () => {
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

  assert.deepEqual(filterParticipantSpaces(spaces, '', 'contact').map((space) => space.kind), ['direct-human', 'group']);
  assert.deepEqual(filterParticipantSpaces(spaces, '', 'agent').map((space) => space.kind), ['self']);
  assert.equal(filterParticipantSpaces(spaces, 'design', 'contact').length, 1);
  assert.equal(filterParticipantSpaces(spaces, 'design', 'agent').length, 0);
  assert.equal(filterParticipantSpaces(spaces, 'kordi', 'agent').length, 1);
});
