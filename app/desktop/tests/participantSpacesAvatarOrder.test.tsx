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
    bridgeHostId: 'cloud',
    bridgeNodeId: accountId,
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
    bridges: ['cloud'],
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

test('group participant avatar stack is stable and uses the first three human participants', () => {
  const alice = participant('acct_a', 'seed-a', 'Alice');
  const bob = participant('acct_b', 'seed-b', 'Bob');
  const carol = participant('acct_c', 'seed-c', 'Carol');
  const dana = participant('acct_d', 'seed-d', 'Dana');

  const first = buildParticipantSpaces([groupConversation([alice, bob, carol, dana])])[0];
  const second = buildParticipantSpaces([groupConversation([dana, carol, bob, alice])])[0];

  assert.deepEqual(first?.avatarStack.map((avatar) => avatar.seed), ['seed-a', 'seed-b', 'seed-c']);
  assert.deepEqual(second?.avatarStack.map((avatar) => avatar.seed), ['seed-a', 'seed-b', 'seed-c']);
});
