import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  bridgeGroupSessionParticipants,
  bridgeGroupMentionRelayTargets,
  bridgeGroupSessionSendTargets,
  bridgeGroupSessionSpaceId,
  bridgeLocalAgentRelayTargets,
  isBridgeGroupSession,
  shouldUseBridgeConversationRouting,
} from '../src/features/chat/messageActions/chatMessages';
import {
  buildChatCreateGroupBridgeInviteParticipants,
  buildChatGroupBridgeUpdateParticipants,
} from '../src/features/chat/chatCreateFlows';
import type { Contact, Conversation, ConversationBridgeTarget } from '../src/kordi-app/types';

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

function contact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 'contact:alice',
    name: 'Alice',
    initials: 'A',
    classType: 'other-users',
    entityType: 'Person',
    subtitle: 'Human contact',
    bridges: ['Bridge'],
    status: 'Online',
    discoverableOn: ['Bridge'],
    detail: 'Works on product',
    owner: 'Alice',
    avatarSeed: 'alice',
    profileImageUrl: null,
    ...overrides,
  };
}

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

test('group create bridge invite metadata carries rich canonical snapshots', () => {
  assert.deepEqual(buildChatCreateGroupBridgeInviteParticipants({
    creator: {
      id: 'human:kh_me',
      displayName: 'Host Owner',
      bridgeNodeId: 'kd_me',
      humanId: 'kh_me',
    },
    contacts: [
      contact({ id: 'contact:alice', name: 'Alice', owner: 'Alice', bridgePeerNodeId: 'kd_alice', bridgeHumanId: 'kh_alice', bridgePeerRuntime: 'person' }),
    ],
  }), [
    { identityId: 'human:kh_me', displayName: 'Host Owner', kind: 'human', role: 'admin', bridgeNodeId: 'kd_me', humanId: 'kh_me', agentId: null },
    { identityId: 'human:kh_alice', displayName: 'Alice', kind: 'human', role: 'person', bridgeNodeId: 'kd_alice', humanId: 'kh_alice', agentId: null, runtime: 'person' },
  ]);
});

test('group update bridge metadata includes agent participants while send targets remain human-only', () => {
  assert.deepEqual(buildChatGroupBridgeUpdateParticipants({
    participants: groupConversation().canonicalParticipants ?? [],
    adminIdentityIds: ['human:me'],
  }), [
    { identityId: 'human:me', displayName: 'Me', kind: 'human', role: 'admin', bridgeNodeId: 'kd_me', humanId: 'kh_me', agentId: null },
    { identityId: 'human:alice', displayName: 'Alice', kind: 'human', role: 'person', bridgeNodeId: 'kd_alice', humanId: 'kh_alice', agentId: null },
    { identityId: 'human:bob', displayName: 'Bob', kind: 'human', role: 'person', bridgeNodeId: 'kd_bob', humanId: 'kh_bob', agentId: null },
    {
      identityId: 'agent:alice',
      displayName: "Alice's Kordi",
      kind: 'agent',
      role: 'delegate',
      ownerIdentityId: 'human:alice',
      ownerDisplayName: 'Alice',
      bridgeNodeId: 'kd_alice',
      humanId: 'kh_alice',
      agentId: 'ka_alice',
    },
  ]);

  assert.deepEqual(bridgeGroupSessionSendTargets(groupConversation(), activeTarget), [
    { hostId: 'host-1', nodeId: 'kd_alice', displayName: 'Alice', ownerName: 'Alice', runtime: 'person', humanId: 'kh_alice', agentId: null },
    { hostId: 'host-1', nodeId: 'kd_bob', displayName: 'Bob', ownerName: 'Bob', runtime: 'person', humanId: 'kh_bob', agentId: null },
  ]);
});

test('group bridge send targets include every non-self human participant and exclude agents', () => {
  assert.deepEqual(bridgeGroupSessionSendTargets(groupConversation(), activeTarget), [
    { hostId: 'host-1', nodeId: 'kd_alice', displayName: 'Alice', ownerName: 'Alice', runtime: 'person', humanId: 'kh_alice', agentId: null },
    { hostId: 'host-1', nodeId: 'kd_bob', displayName: 'Bob', ownerName: 'Bob', runtime: 'person', humanId: 'kh_bob', agentId: null },
  ]);
});

test('group bridge send targets drop participants matching the local host node id', () => {
  const conversation: Conversation = {
    ...groupConversation(),
    canonicalParticipants: [
      ...(groupConversation().canonicalParticipants ?? []),
      {
        id: 'human:bridge-self',
        name: 'Me (bridge)',
        kind: 'human',
        role: 'person',
        source: 'bridge',
        bridgeHostId: 'host-1',
        bridgeNodeId: 'kd_me',
        humanId: 'kh_me',
      },
    ],
  };
  assert.deepEqual(bridgeGroupSessionSendTargets(conversation, activeTarget, ['kd_me']), [
    { hostId: 'host-1', nodeId: 'kd_alice', displayName: 'Alice', ownerName: 'Alice', runtime: 'person', humanId: 'kh_alice', agentId: null },
    { hostId: 'host-1', nodeId: 'kd_bob', displayName: 'Bob', ownerName: 'Bob', runtime: 'person', humanId: 'kh_bob', agentId: null },
  ]);
});

test('group bridge routing remains enabled when the synthetic active target is missing', () => {
  assert.equal(shouldUseBridgeConversationRouting({
    activeConversationIsBridge: false,
    activeConvBridgeTarget: null,
    activeGroupSessionScope: groupConversation(),
  }), true);
});

test('group local-agent relays fan out to every non-self human participant', () => {
  assert.deepEqual(bridgeLocalAgentRelayTargets(groupConversation(), activeTarget), [
    { hostId: 'host-1', nodeId: 'kd_alice', displayName: 'Alice', ownerName: 'Alice', runtime: 'person', humanId: 'kh_alice', agentId: null },
    { hostId: 'host-1', nodeId: 'kd_bob', displayName: 'Bob', ownerName: 'Bob', runtime: 'person', humanId: 'kh_bob', agentId: null },
  ]);
});

test('group bridge-agent mentions relay the visible request to other humans but not the agent owner twice', () => {
  assert.deepEqual(bridgeGroupMentionRelayTargets(groupConversation(), {
    host: { id: 'host-1' },
    peer: { nodeId: 'kd_alice', humanId: 'kh_alice' },
  }, activeTarget), [
    { hostId: 'host-1', nodeId: 'kd_bob', displayName: 'Bob', ownerName: 'Bob', runtime: 'person', humanId: 'kh_bob', agentId: null },
  ]);
});

test('group session root id follows participant-space ids for continuations', () => {
  assert.equal(bridgeGroupSessionSpaceId({
    canonicalSessionId: 'session:group:child',
    participantSpaceId: 'group:session:group:root',
    directness: 'Group chat',
    canonicalParticipants: groupConversation().canonicalParticipants,
  }), 'session:group:root');
});

test('group bridge thread metadata carries rich human and agent members for remote group reconstruction', () => {
  assert.deepEqual(bridgeGroupSessionParticipants(groupConversation()), [
    { identityId: 'human:me', displayName: 'Me', kind: 'human', role: 'self', bridgeNodeId: 'kd_me', humanId: 'kh_me' },
    { identityId: 'human:alice', displayName: 'Alice', kind: 'human', role: 'person', bridgeNodeId: 'kd_alice', humanId: 'kh_alice' },
    { identityId: 'human:bob', displayName: 'Bob', kind: 'human', role: 'person', bridgeNodeId: 'kd_bob', humanId: 'kh_bob' },
    {
      identityId: 'agent:alice',
      displayName: "Alice's Kordi",
      kind: 'agent',
      role: 'delegate',
      ownerIdentityId: 'human:alice',
      ownerDisplayName: 'Alice',
      bridgeNodeId: 'kd_alice',
      humanId: 'kh_alice',
      agentId: 'ka_alice',
    },
  ]);
});

test('self-reference local label is replaced with the public bridge owner name when broadcasting', () => {
  assert.deepEqual(
    bridgeGroupSessionParticipants(groupConversation(), { selfPublicName: 'Kordi User 1' }),
    [
      { identityId: 'human:me', displayName: 'Kordi User 1', kind: 'human', role: 'self', bridgeNodeId: 'kd_me', humanId: 'kh_me' },
      { identityId: 'human:alice', displayName: 'Alice', kind: 'human', role: 'person', bridgeNodeId: 'kd_alice', humanId: 'kh_alice' },
      { identityId: 'human:bob', displayName: 'Bob', kind: 'human', role: 'person', bridgeNodeId: 'kd_bob', humanId: 'kh_bob' },
      {
        identityId: 'agent:alice',
        displayName: "Alice's Kordi",
        kind: 'agent',
        role: 'delegate',
        ownerIdentityId: 'human:alice',
        ownerDisplayName: 'Alice',
        bridgeNodeId: 'kd_alice',
        humanId: 'kh_alice',
        agentId: 'ka_alice',
      },
    ],
  );
});

test('self-reference broadcast falls through to local label when no public name is provided', () => {
  // Defensive: if the bridge host has no owner_name set yet, we still emit the local "Me"
  // rather than dropping the participant entirely; the receiver's sanitizer is the second line of defence.
  assert.deepEqual(
    bridgeGroupSessionParticipants(groupConversation(), { selfPublicName: null }),
    [
      { identityId: 'human:me', displayName: 'Me', kind: 'human', role: 'self', bridgeNodeId: 'kd_me', humanId: 'kh_me' },
      { identityId: 'human:alice', displayName: 'Alice', kind: 'human', role: 'person', bridgeNodeId: 'kd_alice', humanId: 'kh_alice' },
      { identityId: 'human:bob', displayName: 'Bob', kind: 'human', role: 'person', bridgeNodeId: 'kd_bob', humanId: 'kh_bob' },
      {
        identityId: 'agent:alice',
        displayName: "Alice's Kordi",
        kind: 'agent',
        role: 'delegate',
        ownerIdentityId: 'human:alice',
        ownerDisplayName: 'Alice',
        bridgeNodeId: 'kd_alice',
        humanId: 'kh_alice',
        agentId: 'ka_alice',
      },
    ],
  );
});

test('non-self-reference local label is preserved even when a public name is provided', () => {
  const conversation: Conversation = {
    ...groupConversation(),
    canonicalParticipants: groupConversation().canonicalParticipants?.map((participant) => (
      participant.role === 'self' ? { ...participant, name: 'Custom Self Label' } : participant
    )),
  };
  const result = bridgeGroupSessionParticipants(conversation, { selfPublicName: 'Kordi User 1' });
  assert.equal(result[0]?.displayName, 'Custom Self Label');
});
