import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  collaborationGroupSessionParticipants,
  collaborationGroupMentionRelayTargets,
  collaborationGroupSessionSendTargets,
  collaborationGroupSessionSpaceId,
  collaborationLocalAgentMentionCanRelay,
  collaborationLocalAgentRelayTargets,
  isCollaborationGroupSession,
  shouldUseCollaborationConversationRouting,
} from '../src/features/chat/messageActions/chatMessages';
import type { Conversation, ConversationCollaborationTarget } from '../src/kordi-app/types';

function groupConversation(): Conversation {
  return {
    id: 'session:group:triad',
    canonicalSessionId: 'session:group:triad',
    name: 'Alice, Bob',
    type: 'person',
    subtitle: '',
    unread: 0,
    collaborationSources: ['Bridge'],
    trust: 'Bridge',
    directness: 'Group chat',
    participants: ['Me', 'Alice', 'Bob'],
    participantSpaceId: 'group:session:group:triad',
    canonicalParticipants: [
      { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', humanId: 'kh_me', sourceIdentityId: 'kd_me' },
      { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', sourceHostId: 'host-1', sourceIdentityId: 'kd_alice', humanId: 'kh_alice' },
      { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', sourceHostId: 'host-1', sourceIdentityId: 'kd_bob', humanId: 'kh_bob' },
      { id: 'agent:alice', name: "Alice's Kordi", kind: 'agent', role: 'delegate', source: 'bridge', ownerIdentityId: 'human:alice', ownerName: 'Alice', sourceHostId: 'host-1', sourceIdentityId: 'kd_alice', humanId: 'kh_alice', agentId: 'ka_alice' },
    ],
    messages: [],
  };
}

const activeTarget: ConversationCollaborationTarget = {
  hostId: 'host-1',
  nodeId: 'kd_alice',
  displayName: 'Alice',
  ownerName: 'Alice',
  runtime: 'person',
  humanId: 'kh_alice',
};

test('detects bridge-backed group sessions even when active header type is person', () => {
  assert.equal(isCollaborationGroupSession(groupConversation()), true);
  assert.equal(isCollaborationGroupSession({
    ...groupConversation(),
    canonicalSessionId: 'session:bridge:humans:alice',
    participantSpaceId: undefined,
    directness: 'Direct person chat',
    canonicalParticipants: groupConversation().canonicalParticipants?.filter((participant) => participant.name !== 'Bob'),
  }), false);
});

test('group bridge send targets include every non-self human participant and exclude agents', () => {
  assert.deepEqual(collaborationGroupSessionSendTargets(groupConversation(), activeTarget), [
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
        sourceHostId: 'host-1',
        sourceIdentityId: 'kd_me',
        humanId: 'kh_me',
      },
    ],
  };
  assert.deepEqual(collaborationGroupSessionSendTargets(conversation, activeTarget, ['kd_me']), [
    { hostId: 'host-1', nodeId: 'kd_alice', displayName: 'Alice', ownerName: 'Alice', runtime: 'person', humanId: 'kh_alice', agentId: null },
    { hostId: 'host-1', nodeId: 'kd_bob', displayName: 'Bob', ownerName: 'Bob', runtime: 'person', humanId: 'kh_bob', agentId: null },
  ]);
});

test('group bridge routing remains enabled when the synthetic active target is missing', () => {
  assert.equal(shouldUseCollaborationConversationRouting({
    activeConversationUsesCollaboration: false,
    activeConvCollaborationTarget: null,
    activeGroupSessionScope: groupConversation(),
  }), true);
});

test('group local-agent mention can relay even when no synthetic active bridge target exists', () => {
  assert.equal(collaborationLocalAgentMentionCanRelay({
    activeGroupSessionIsGroup: true,
    activeConvCollaborationTarget: null,
    hasLocalAgentMention: true,
  }), true);
});

test('group local-agent relays fan out to every non-self human participant', () => {
  assert.deepEqual(collaborationLocalAgentRelayTargets(groupConversation(), activeTarget), [
    { hostId: 'host-1', nodeId: 'kd_alice', displayName: 'Alice', ownerName: 'Alice', runtime: 'person', humanId: 'kh_alice', agentId: null },
    { hostId: 'host-1', nodeId: 'kd_bob', displayName: 'Bob', ownerName: 'Bob', runtime: 'person', humanId: 'kh_bob', agentId: null },
  ]);
});

test('group bridge-agent mentions relay the visible request to other humans but not the agent owner twice', () => {
  assert.deepEqual(collaborationGroupMentionRelayTargets(groupConversation(), {
    host: { id: 'host-1' },
    peer: { nodeId: 'kd_alice', humanId: 'kh_alice' },
  }, activeTarget), [
    { hostId: 'host-1', nodeId: 'kd_bob', displayName: 'Bob', ownerName: 'Bob', runtime: 'person', humanId: 'kh_bob', agentId: null },
  ]);
});

test('group session root id follows participant-space ids for continuations', () => {
  assert.equal(collaborationGroupSessionSpaceId({
    canonicalSessionId: 'session:group:child',
    participantSpaceId: 'group:session:group:root',
    directness: 'Group chat',
    canonicalParticipants: groupConversation().canonicalParticipants,
  }), 'session:group:root');
});

test('group bridge thread metadata carries people and explicit agents for remote reconstruction', () => {
  assert.deepEqual(collaborationGroupSessionParticipants(groupConversation()), [
    { identityId: 'human:me', displayName: 'Me', kind: 'human', role: 'self', sourceIdentityId: 'kd_me', humanId: 'kh_me', runtime: 'person' },
    { identityId: 'human:alice', displayName: 'Alice', kind: 'human', role: 'person', sourceIdentityId: 'kd_alice', humanId: 'kh_alice', runtime: 'person' },
    { identityId: 'human:bob', displayName: 'Bob', kind: 'human', role: 'person', sourceIdentityId: 'kd_bob', humanId: 'kh_bob', runtime: 'person' },
    { identityId: 'agent:alice', displayName: "Alice's Kordi", kind: 'agent', role: 'delegate', ownerIdentityId: 'human:alice', ownerDisplayName: 'Alice', sourceIdentityId: 'kd_alice', humanId: 'kh_alice', agentId: 'ka_alice', runtime: 'agent' },
  ]);
});

test('self-reference local label is replaced with the public bridge owner name when broadcasting', () => {
  assert.deepEqual(
    collaborationGroupSessionParticipants(groupConversation(), { selfPublicName: 'Kordi User 1' }),
    [
      { identityId: 'human:me', displayName: 'Kordi User 1', kind: 'human', role: 'self', sourceIdentityId: 'kd_me', humanId: 'kh_me', runtime: 'person' },
      { identityId: 'human:alice', displayName: 'Alice', kind: 'human', role: 'person', sourceIdentityId: 'kd_alice', humanId: 'kh_alice', runtime: 'person' },
      { identityId: 'human:bob', displayName: 'Bob', kind: 'human', role: 'person', sourceIdentityId: 'kd_bob', humanId: 'kh_bob', runtime: 'person' },
      { identityId: 'agent:alice', displayName: "Alice's Kordi", kind: 'agent', role: 'delegate', ownerIdentityId: 'human:alice', ownerDisplayName: 'Alice', sourceIdentityId: 'kd_alice', humanId: 'kh_alice', agentId: 'ka_alice', runtime: 'agent' },
    ],
  );
});

test('self-reference broadcast falls through to local label when no public name is provided', () => {
  // Defensive: if the bridge host has no owner_name set yet, we still emit the local "Me"
  // rather than dropping the participant entirely; the receiver's sanitizer is the second line of defence.
  assert.deepEqual(
    collaborationGroupSessionParticipants(groupConversation(), { selfPublicName: null }),
    [
      { identityId: 'human:me', displayName: 'Me', kind: 'human', role: 'self', sourceIdentityId: 'kd_me', humanId: 'kh_me', runtime: 'person' },
      { identityId: 'human:alice', displayName: 'Alice', kind: 'human', role: 'person', sourceIdentityId: 'kd_alice', humanId: 'kh_alice', runtime: 'person' },
      { identityId: 'human:bob', displayName: 'Bob', kind: 'human', role: 'person', sourceIdentityId: 'kd_bob', humanId: 'kh_bob', runtime: 'person' },
      { identityId: 'agent:alice', displayName: "Alice's Kordi", kind: 'agent', role: 'delegate', ownerIdentityId: 'human:alice', ownerDisplayName: 'Alice', sourceIdentityId: 'kd_alice', humanId: 'kh_alice', agentId: 'ka_alice', runtime: 'agent' },
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
  const result = collaborationGroupSessionParticipants(conversation, { selfPublicName: 'Kordi User 1' });
  assert.equal(result[0]?.displayName, 'Custom Self Label');
});
