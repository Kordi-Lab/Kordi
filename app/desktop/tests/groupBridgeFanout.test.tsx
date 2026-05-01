import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  bridgeGroupSessionParticipants,
  bridgeGroupSessionSendTargets,
  isBridgeGroupSession,
} from '../src/features/chat/messageActions/chatMessages';
import type { Conversation, ConversationBridgeTarget } from '../src/kordi-app/types';

function groupConversation(): Conversation {
  return {
    id: 'session:group:triad',
    canonicalSessionId: 'session:group:triad',
    name: 'Alice, Bob',
    type: 'person',
    subtitle: '',
    unread: 0,
    bridges: ['Bridge'],
    trust: 'Bridge',
    directness: 'Group chat',
    participants: ['Me', 'Alice', 'Bob'],
    participantSpaceId: 'group:session:group:triad',
    canonicalParticipants: [
      { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', humanId: 'kh_me', bridgeNodeId: 'kd_me' },
      { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', bridgeHostId: 'host-1', bridgeNodeId: 'kd_alice', humanId: 'kh_alice' },
      { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', bridgeHostId: 'host-1', bridgeNodeId: 'kd_bob', humanId: 'kh_bob' },
      { id: 'agent:alice', name: "Alice's Kordi", kind: 'agent', role: 'delegate', source: 'bridge', ownerIdentityId: 'human:alice', ownerName: 'Alice', bridgeHostId: 'host-1', bridgeNodeId: 'kd_alice', humanId: 'kh_alice', agentId: 'ka_alice' },
    ],
    messages: [],
  };
}

const activeTarget: ConversationBridgeTarget = {
  hostId: 'host-1',
  nodeId: 'kd_alice',
  displayName: 'Alice',
  ownerName: 'Alice',
  runtime: 'person',
  humanId: 'kh_alice',
};

test('detects bridge-backed group sessions even when active header type is person', () => {
  assert.equal(isBridgeGroupSession(groupConversation()), true);
  assert.equal(isBridgeGroupSession({
    ...groupConversation(),
    canonicalSessionId: 'session:bridge:humans:alice',
    participantSpaceId: undefined,
    directness: 'Direct person chat',
    canonicalParticipants: groupConversation().canonicalParticipants?.filter((participant) => participant.name !== 'Bob'),
  }), false);
});

test('group bridge send targets include every non-self human participant and exclude agents', () => {
  assert.deepEqual(bridgeGroupSessionSendTargets(groupConversation(), activeTarget), [
    { hostId: 'host-1', nodeId: 'kd_alice', displayName: 'Alice', ownerName: 'Alice', runtime: 'person', humanId: 'kh_alice', agentId: null },
    { hostId: 'host-1', nodeId: 'kd_bob', displayName: 'Bob', ownerName: 'Bob', runtime: 'person', humanId: 'kh_bob', agentId: null },
  ]);
});

test('group bridge thread metadata carries all human members for remote group reconstruction', () => {
  assert.deepEqual(bridgeGroupSessionParticipants(groupConversation()), [
    { identityId: 'human:me', displayName: 'Me', role: 'self', bridgeNodeId: 'kd_me', humanId: 'kh_me' },
    { identityId: 'human:alice', displayName: 'Alice', role: 'person', bridgeNodeId: 'kd_alice', humanId: 'kh_alice' },
    { identityId: 'human:bob', displayName: 'Bob', role: 'person', bridgeNodeId: 'kd_bob', humanId: 'kh_bob' },
  ]);
});
