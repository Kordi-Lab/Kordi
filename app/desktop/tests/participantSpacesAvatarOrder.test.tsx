import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildParticipantSpaces } from '../src/features/chat/participantSpaces';
import type { Conversation, ConversationParticipant } from '../src/kordi-app/types';

function participant(accountId: string, avatarKey: string, name = accountId): ConversationParticipant {
  return {
    id: `human:${accountId}`,
    name,
    kind: 'human',
    role: 'person',
    source: 'bridge',
    sourceHostId: 'cloud',
    sourceIdentityId: accountId,
    humanId: accountId,
    avatarKey,
  };
}

function groupConversation(participants: ConversationParticipant[]): Conversation {
  return {
    id: 'session:group:test',
    canonicalSessionId: 'session:group:test',
    name: 'Cloud group',
    type: 'person',
    subtitle: 'Group',
    unread: 0,
    collaborationSources: ['cloud'],
    trust: 'Bridge',
    directness: 'Group chat',
    participants: participants.map((item) => item.name),
    canonicalParticipants: participants,
    messages: [],
    participantSpaceId: 'group:cloud-test',
    updatedAtLabel: 'Now',
  };
}

test('cloud group sessions with the same people collapse into one group space even if legacy metadata has different group ids', () => {
  const alice = participant('acct_a', 'seed-a', 'Alice');
  const bob = participant('acct_b', 'seed-b', 'Bob');
  const carol = participant('acct_c', 'seed-c', 'Carol');

  const spaces = buildParticipantSpaces([
    {
      ...groupConversation([alice, bob, carol]),
      id: 'session:group:one',
      canonicalSessionId: 'session:group:one',
      participantSpaceId: 'group:session:group:one',
      metadata: { kind: 'chat-group', groupSpaceId: 'session:group:one', customName: 'Cloud group' },
    },
    {
      ...groupConversation([alice, bob, carol]),
      id: 'session:group:two',
      canonicalSessionId: 'session:group:two',
      participantSpaceId: 'group:session:group:two',
      metadata: { kind: 'chat-group', groupSpaceId: 'session:group:two', customName: 'Cloud group' },
    },
  ]);

  assert.equal(spaces.filter((space) => space.kind === 'group').length, 1);
  assert.deepEqual(spaces[0]?.sessions.map((session) => session.id).sort(), ['session:group:one', 'session:group:two']);
});

test('direct contacts with the same display name remain separate participant spaces', () => {
  const baseConversation = {
    type: 'person' as const,
    subtitle: 'Direct human chat',
    unread: 0,
    collaborationSources: ['cloud'],
    trust: 'Bridge',
    directness: 'Direct person chat',
    participants: ['Me', 'Alex Morgan'],
    messages: [],
    updatedAtLabel: 'Now',
  };
  const spaces = buildParticipantSpaces([{
    ...baseConversation,
    id: 'bridge:cloud:acct_a:person',
    canonicalSessionId: 'bridge:cloud:acct_a:person',
    name: 'Alex Morgan',
    collaborationTarget: { hostId: 'cloud', nodeId: 'acct_a', humanId: 'acct_a', runtime: 'person' },
    identity: { sourceHostId: 'cloud', localHumanId: 'acct_me', localHumanName: 'Me', remoteHumanId: 'acct_a', remoteHumanName: 'Alex Morgan' },
  }, {
    ...baseConversation,
    id: 'bridge:cloud:acct_b:person',
    canonicalSessionId: 'bridge:cloud:acct_b:person',
    name: 'Alex Morgan',
    collaborationTarget: { hostId: 'cloud', nodeId: 'acct_b', humanId: 'acct_b', runtime: 'person' },
    identity: { sourceHostId: 'cloud', localHumanId: 'acct_me', localHumanName: 'Me', remoteHumanId: 'acct_b', remoteHumanName: 'Alex Morgan' },
  }]);

  assert.equal(spaces.filter((space) => space.kind === 'direct-human').length, 2);
  assert.deepEqual(spaces.map((space) => space.sessions[0]?.id).sort(), ['bridge:cloud:acct_a:person', 'bridge:cloud:acct_b:person']);
});

test('fallback participant spaces preserve per-participant profile image urls', () => {
  const spaces = buildParticipantSpaces([{
    id: 'bridge:cloud:acct_peer:person',
    canonicalSessionId: 'bridge:cloud:acct_peer:person',
    name: 'Alex Morgan',
    type: 'person',
    subtitle: 'Direct human chat',
    unread: 0,
    collaborationSources: ['cloud'],
    trust: 'Bridge',
    directness: 'Direct person chat',
    participants: ['Me', 'Alex Morgan'],
    participantAvatarSeeds: { Me: 'acct_me', 'Alex Morgan': 'acct_peer' },
    participantProfileImageUrls: { Me: 'https://images.test/me.png', 'Alex Morgan': 'https://images.test/peer.png' },
    messages: [],
    updatedAtLabel: 'Now',
  }]);

  assert.equal(spaces[0]?.avatarStack[0]?.imageUrl, 'https://images.test/peer.png');
  assert.equal(spaces[0]?.participants.find((participant) => participant.name === 'Me')?.profileImageUrl, 'https://images.test/me.png');
});

test('group participant avatar stack uses stable group-member identity', () => {
  const alice = participant('acct_a', 'seed-a', 'Alice');
  const bob = participant('acct_b', 'seed-b', 'Bob');
  const carol = participant('acct_c', 'seed-c', 'Carol');
  const dana = participant('acct_d', 'seed-d', 'Dana');

  const metadata = {
    groupSpaceId: 'session:group:test',
    avatarAccountIds: ['acct_b', 'acct_d', 'acct_a', 'acct_c'],
  };
  const first = buildParticipantSpaces([{
    ...groupConversation([alice, bob, carol, dana]),
    metadata,
  }])[0];
  const second = buildParticipantSpaces([{
    ...groupConversation([dana, carol, bob, alice]),
    metadata,
  }])[0];

  assert.deepEqual(first?.avatarStack.map((avatar) => avatar.seed), ['seed-a', 'seed-b', 'seed-c']);
  assert.deepEqual(second?.avatarStack.map((avatar) => avatar.seed), ['seed-a', 'seed-b', 'seed-c']);
});

test('group avatar order does not follow child-session activity', () => {
  const alice = participant('acct_a', 'seed-a', 'Alice');
  const bob = participant('acct_b', 'seed-b', 'Bob');
  const carol = participant('acct_c', 'seed-c', 'Carol');
  const group = (firstActivity: number, secondActivity: number) => buildParticipantSpaces([{
    ...groupConversation([alice, bob, carol]),
    id: 'session:group:first',
    canonicalSessionId: 'session:group:first',
    canonicalCreatedAtMs: 1,
    participantSpaceId: 'group:shared',
    metadata: { groupSpaceId: 'shared', avatarAccountIds: ['acct_b', 'acct_a', 'acct_c'] },
    _updatedAtMs: firstActivity,
  }, {
    ...groupConversation([alice, bob, carol]),
    id: 'session:group:second',
    canonicalSessionId: 'session:group:second',
    canonicalCreatedAtMs: 2,
    participantSpaceId: 'group:shared',
    metadata: { groupSpaceId: 'shared', avatarAccountIds: ['acct_c', 'acct_b', 'acct_a'] },
    _updatedAtMs: secondActivity,
  }])[0]?.avatarStack.map((avatar) => avatar.seed);

  assert.deepEqual(group(10, 20), ['seed-a', 'seed-b', 'seed-c']);
  assert.deepEqual(group(30, 5), ['seed-a', 'seed-b', 'seed-c']);
});
