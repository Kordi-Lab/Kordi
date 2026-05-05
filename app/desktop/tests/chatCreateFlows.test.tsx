import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildChatCreateAgentOptions,
  buildChatAgentSessionMetadata,
  buildChatAgentSessionKind,
  buildChatCreateGroupBridgeInviteParticipants,
  buildChatCreateGroupBridgeInviteTargets,
  buildChatCreateGroupMetadata,
  buildChatGroupBridgeUpdateParticipants,
  buildChatGroupBridgeUpdateTargets,
  buildChatCreatePersonOptions,
  buildParticipantSpaceContinuationMetadata,
  canCreateGroup,
  chatSessionIdForAgentStart,
  chatSessionIdForParticipantSpaceContinuation,
  chatSessionIdForPersonStart,
  existingBlankSessionIdForAgentStart,
  existingBlankSessionIdForParticipantSpace,
  groupDefaultName,
  participantSpaceCanonicalSessionIds,
} from '../src/features/chat/chatCreateFlows';
import type { Agent, Contact, Conversation, ParticipantSpaceViewModel } from '../src/kordi-app/types';

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

function participantSpace(overrides: Partial<ParticipantSpaceViewModel> = {}): ParticipantSpaceViewModel {
  return {
    id: 'direct-human:human:alice',
    kind: 'direct-human',
    title: 'Alice',
    participants: [
      { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
      { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', bridgeNodeId: 'node-alice', avatarKey: 'alice' },
    ],
    participantCount: 2,
    sessionCount: 1,
    unread: 0,
    updatedAtLabel: '10:00',
    updatedAtMs: 1,
    preview: 'Hi',
    avatarStack: [{ kind: 'human', seed: 'alice', imageUrl: null }],
    sessions: [{
      id: 'session:bridge:humans:old',
      canonicalSessionId: 'session:bridge:humans:old',
      title: 'Hi',
      preview: 'Hi',
      unread: 0,
      updatedAtLabel: '10:00',
      updatedAtMs: 1,
      participantCount: 2,
      conversation: {
        id: 'session:bridge:humans:old',
        canonicalSessionId: 'session:bridge:humans:old',
        name: 'Hi',
        type: 'person',
        subtitle: 'Hi',
        unread: 0,
        bridges: ['Bridge'],
        trust: 'Bridge',
        directness: 'Direct chat',
        participants: ['Me', 'Alice'],
        canonicalParticipants: [
          { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
          { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', bridgeNodeId: 'node-alice', avatarKey: 'alice' },
        ],
        messages: [],
        updatedAtLabel: '10:00',
      },
    }],
    ...overrides,
  };
}

function chatConversation(overrides: Partial<Conversation & { _updatedAtMs?: number }> = {}): Conversation & { _updatedAtMs?: number } {
  return {
    id: 'session:default',
    canonicalSessionId: 'session:default',
    name: 'New session',
    type: 'owned-agent',
    subtitle: 'New session',
    unread: 0,
    bridges: ['Bridge'],
    trust: 'Bridge',
    directness: 'Direct chat',
    participants: ['Me', 'Kordi'],
    canonicalParticipants: [
      { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
      { id: 'agent:kordi', name: 'Kordi', kind: 'agent', role: 'delegate', source: 'local', agentId: 'agent:kordi', avatarKey: 'kordi' },
    ],
    messages: [],
    canonicalMessageCount: 0,
    updatedAtLabel: '10:00',
    _updatedAtMs: 1,
    ...overrides,
  };
}

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent:kordi',
    name: 'Kordi',
    role: 'Coding partner',
    messaging: 'Available',
    status: 'Ready',
    tasks: 0,
    defaultProvider: 'openai',
    defaultModel: 'gpt-5.2',
    bridgesConfig: 'Bridge',
    contactId: 'contact:kordi',
    systemPrompt: '',
    xMd: '',
    identityFiles: [],
    loadedTools: [],
    loadedSkills: [],
    loadedPlugins: [],
    lastActivities: [],
    avatarSeed: 'kordi',
    profileImageUrl: null,
    ...overrides,
  };
}

test('buildChatCreatePersonOptions excludes agent contacts', () => {
  const options = buildChatCreatePersonOptions([
    contact({ id: 'person:alice', name: 'Alice', entityType: 'Person' }),
    contact({ id: 'agent:one', name: 'Build bot', entityType: 'Owned agent', classType: 'my-agents' }),
    contact({ id: 'agent:two', name: 'Review bot', entityType: 'External agent', classType: 'other-users-agents' }),
  ]);

  assert.deepEqual(options.map((option) => option.id), ['person:alice']);
  assert.equal(options[0]?.label, 'Alice');
});

test('participant-space continuations inherit bridge target metadata from the source session', () => {
  assert.deepEqual(buildParticipantSpaceContinuationMetadata({
    sourceMetadata: {
      source: 'bridge-session-thread',
      bridgeConversationId: 'bridge:host:node:person',
      bridgeHostId: 'host-1',
      peerNodeId: 'node-peer',
      peerRuntime: 'person',
      peerDisplayName: 'Peer display',
      peerOwnerName: 'Peer owner',
      peerHumanId: 'human-peer',
    },
    continuedFromSessionId: 'session:bridge:humans:source',
    continuedFromSpaceId: 'direct-human:human:peer',
    participantSpaceKind: 'direct-human',
  }), {
    createdFrom: 'chat-create-flow',
    source: 'bridge-session-thread',
    bridgeConversationId: 'bridge:host:node:person',
    bridgeHostId: 'host-1',
    peerNodeId: 'node-peer',
    peerRuntime: 'person',
    peerDisplayName: 'Peer display',
    peerOwnerName: 'Peer owner',
    peerHumanId: 'human-peer',
    continuedFromSessionId: 'session:bridge:humans:source',
    continuedFromSpaceId: 'direct-human:human:peer',
    participantSpaceKind: 'direct-human',
  });
});

test('buildChatCreateAgentOptions derives agent rows from displayed agents', () => {
  const options = buildChatCreateAgentOptions([
    agent({ id: 'agent:kordi', name: 'Kordi', role: 'Coding partner' }),
    agent({ id: 'agent:reviewer', name: 'Reviewer', role: 'Code review' }),
  ]);

  assert.deepEqual(options.map((option) => option.label), ['Kordi', 'Reviewer']);
  assert.equal(options[0]?.detail, 'Coding partner');
});

test('person create flow starts a fresh direct-person session id for each new same-contact chat', () => {
  assert.equal(chatSessionIdForPersonStart('first-id'), 'session:direct-person:first-id');
  assert.equal(chatSessionIdForPersonStart('second-id'), 'session:direct-person:second-id');
});

test('agent create flow starts a new selected-agent session under My chats', () => {
  const selectedAgent = agent({ id: 'agent:reviewer', name: 'Reviewer', isOwned: true });

  assert.equal(buildChatAgentSessionKind(selectedAgent), 'self-agent');
  assert.equal(chatSessionIdForAgentStart(selectedAgent, 'next-id'), 'session:self-agent:next-id');
  assert.deepEqual(buildChatAgentSessionMetadata(selectedAgent), {
    createdFrom: 'chat-create-flow',
    agentId: 'agent:reviewer',
    participantSpaceKind: 'self',
  });
});

test('external bridge agent create flow stores bridge target metadata for My chats routing', () => {
  const remoteAgent = agent({
    id: 'agent:bob',
    name: 'Bob agent',
    isOwned: false,
    bridgeHostId: 'host-1',
    bridgePeerNodeId: 'node-shared',
    bridgePeerRuntime: 'kordi-desktop',
    bridgeAgentId: 'agent-bob',
    bridgeOwnerName: 'Bob',
  });

  assert.equal(buildChatAgentSessionKind(remoteAgent), 'direct-agent');
  assert.equal(chatSessionIdForAgentStart(remoteAgent, 'next-id'), 'session:direct-agent:next-id');
  assert.deepEqual(buildChatAgentSessionMetadata(remoteAgent), {
    createdFrom: 'chat-create-flow',
    agentId: 'agent:bob',
    participantSpaceKind: 'self',
    bridgeHostId: 'host-1',
    peerNodeId: 'node-shared',
    peerRuntime: 'kordi-desktop',
    peerDisplayName: 'Bob agent',
    peerOwnerName: 'Bob',
    peerAgentId: 'agent-bob',
    targetAgentId: 'agent-bob',
  });
});

test('existingBlankSessionIdForAgentStart reuses the newest empty selected-agent session', () => {
  const selectedAgent = agent({ id: 'agent:kordi', name: 'Kordi', isOwned: true });
  const conversations = [
    chatConversation({
      id: 'session:self-agent:old-blank',
      canonicalSessionId: 'session:self-agent:old-blank',
      name: 'Kordi',
      metadata: { createdFrom: 'chat-create-flow', agentId: 'agent:kordi', participantSpaceKind: 'self' },
      _updatedAtMs: 1,
    }),
    chatConversation({
      id: 'session:self-agent:newer-real',
      canonicalSessionId: 'session:self-agent:newer-real',
      name: 'Kordi',
      metadata: { createdFrom: 'chat-create-flow', agentId: 'agent:kordi', participantSpaceKind: 'self' },
      messages: [{ role: 'person', sender: 'Me', text: 'Use this one?', time: '10:02' }],
      canonicalMessageCount: 1,
      _updatedAtMs: 3,
    }),
    chatConversation({
      id: 'session:self-agent:other-blank',
      canonicalSessionId: 'session:self-agent:other-blank',
      name: 'Reviewer',
      participants: ['Me', 'Reviewer'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'agent:reviewer', name: 'Reviewer', kind: 'agent', role: 'delegate', source: 'local', agentId: 'agent:reviewer', avatarKey: 'reviewer' },
      ],
      metadata: { createdFrom: 'chat-create-flow', agentId: 'agent:reviewer', participantSpaceKind: 'self' },
      _updatedAtMs: 4,
    }),
    chatConversation({
      id: 'session:self-agent:newest-blank',
      canonicalSessionId: 'session:self-agent:newest-blank',
      name: 'Kordi',
      metadata: { createdFrom: 'chat-create-flow', agentId: 'agent:kordi', participantSpaceKind: 'self' },
      _updatedAtMs: 5,
    }),
  ];

  assert.equal(existingBlankSessionIdForAgentStart(selectedAgent, conversations), 'session:self-agent:newest-blank');
});

test('canCreateGroup requires at least two unique people contacts', () => {
  assert.equal(canCreateGroup([]), false);
  assert.equal(canCreateGroup(['contact:alice']), false);
  assert.equal(canCreateGroup(['contact:alice', 'contact:alice']), false);
  assert.equal(canCreateGroup(['contact:alice', 'contact:bob']), true);
});

test('groupDefaultName uses people names only and truncates long groups', () => {
  assert.equal(groupDefaultName(['Alice', 'Bob']), 'Alice, Bob');
  assert.equal(groupDefaultName(['Alice', 'Bob', 'Chen', 'Dev']), 'Alice, Bob +2 more');
});

test('group create bridge invites target every bridge-backed selected person', () => {
  const targets = buildChatCreateGroupBridgeInviteTargets([
    contact({ id: 'contact:alice', name: 'Alice', bridgeHostId: 'host-1', bridgePeerNodeId: 'kd_alice', bridgeHumanId: 'kh_alice' }),
    contact({ id: 'contact:bob', name: 'Bob', owner: 'Bobby', bridgeHostId: 'host-1', bridgePeerNodeId: 'kd_bob', bridgeHumanId: 'kh_bob' }),
    contact({ id: 'contact:local-only', name: 'Local' }),
  ]);

  assert.deepEqual(targets, [
    { hostId: 'host-1', nodeId: 'kd_alice', displayName: 'Alice', ownerName: 'Alice', identityId: 'human:kh_alice', humanId: 'kh_alice', runtime: null },
    { hostId: 'host-1', nodeId: 'kd_bob', displayName: 'Bob', ownerName: 'Bobby', identityId: 'human:kh_bob', humanId: 'kh_bob', runtime: null },
  ]);
});

test('group create bridge invite metadata includes creator and selected people', () => {
  const participants = buildChatCreateGroupBridgeInviteParticipants({
    creator: {
      id: 'human:kh_me',
      displayName: 'Testuser2',
      bridgeNodeId: 'kd_me',
      humanId: 'kh_me',
    },
    contacts: [
      contact({ id: 'contact:user1', name: 'Testuser1', bridgePeerNodeId: 'kd_user1', bridgeHumanId: 'kh_user1' }),
      contact({ id: 'contact:user3', name: 'Testuser3', bridgePeerNodeId: 'kd_user3', bridgeHumanId: 'kh_user3' }),
    ],
  });

  assert.deepEqual(participants, [
    { identityId: 'human:kh_me', displayName: 'Testuser2', kind: 'human', role: 'admin', bridgeNodeId: 'kd_me', humanId: 'kh_me', agentId: null },
    { identityId: 'human:kh_user1', displayName: 'Testuser1', kind: 'human', role: 'person', bridgeNodeId: 'kd_user1', humanId: 'kh_user1', agentId: null },
    { identityId: 'human:kh_user3', displayName: 'Testuser3', kind: 'human', role: 'person', bridgeNodeId: 'kd_user3', humanId: 'kh_user3', agentId: null },
  ]);
});

test('group update bridge metadata targets every other bridge-backed human and carries admin roles', () => {
  const participants = [
    { id: 'human:me', name: 'Testuser2', kind: 'human', role: 'self', source: 'bridge', bridgeHostId: 'host-1', bridgeNodeId: 'kd_me', humanId: 'kh_me', avatarKey: 'me' },
    { id: 'human:user1', name: 'Testuser1', kind: 'human', role: 'person', source: 'bridge', bridgeHostId: 'host-1', bridgeNodeId: 'kd_user1', humanId: 'kh_user1', avatarKey: 'user1' },
    { id: 'human:user3', name: 'Testuser3', kind: 'human', role: 'person', source: 'bridge', bridgeHostId: 'host-1', bridgeNodeId: 'kd_user3', humanId: 'kh_user3', avatarKey: 'user3' },
    { id: 'agent:local', name: 'My Kordi', kind: 'agent', role: 'owned-agent', source: 'local', avatarKey: 'agent' },
  ] satisfies Conversation['canonicalParticipants'];

  assert.deepEqual(buildChatGroupBridgeUpdateTargets({ actorIdentityId: 'human:me', participants }), [
    { hostId: 'host-1', nodeId: 'kd_user1', displayName: 'Testuser1', ownerName: 'Testuser1', identityId: 'human:user1', humanId: 'kh_user1', runtime: null },
    { hostId: 'host-1', nodeId: 'kd_user3', displayName: 'Testuser3', ownerName: 'Testuser3', identityId: 'human:user3', humanId: 'kh_user3', runtime: null },
  ]);
  assert.deepEqual(buildChatGroupBridgeUpdateParticipants({ participants, adminIdentityIds: ['human:me'] }), [
    { identityId: 'human:me', displayName: 'Testuser2', kind: 'human', role: 'admin', bridgeNodeId: 'kd_me', humanId: 'kh_me', agentId: null },
    { identityId: 'human:user1', displayName: 'Testuser1', kind: 'human', role: 'person', bridgeNodeId: 'kd_user1', humanId: 'kh_user1', agentId: null },
    { identityId: 'human:user3', displayName: 'Testuser3', kind: 'human', role: 'person', bridgeNodeId: 'kd_user3', humanId: 'kh_user3', agentId: null },
    { identityId: 'agent:local', displayName: 'My Kordi', kind: 'agent', role: 'owned-agent', bridgeNodeId: null, humanId: null, agentId: null },
  ]);
});

test('chatSessionIdForParticipantSpaceContinuation keeps Bridge human session ids consistent', () => {
  assert.equal(
    chatSessionIdForParticipantSpaceContinuation(participantSpace(), 'next-id'),
    'session:bridge:humans:next-id',
  );
  assert.equal(
    chatSessionIdForParticipantSpaceContinuation(participantSpace({
      sessions: [{
        ...participantSpace().sessions[0],
        id: 'session:direct-person:old',
        canonicalSessionId: 'session:direct-person:old',
      }],
      participants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:local-alice', name: 'Alice', kind: 'human', role: 'person', source: 'local', avatarKey: 'alice' },
      ],
    }), 'next-id'),
    'session:direct-person:next-id',
  );
});

test('existingBlankSessionIdForParticipantSpace reuses the newest blank session instead of creating another', () => {
  const space = participantSpace({
    sessions: [
      {
        ...participantSpace().sessions[0],
        id: 'session:bridge:humans:blank-newer',
        canonicalSessionId: 'session:bridge:humans:blank-newer',
        title: 'New session',
        preview: 'New session',
        updatedAtMs: 3,
        conversation: {
          ...participantSpace().sessions[0].conversation,
          id: 'session:bridge:humans:blank-newer',
          canonicalSessionId: 'session:bridge:humans:blank-newer',
          name: 'New session',
          subtitle: 'New session',
          messages: [],
        },
      },
      {
        ...participantSpace().sessions[0],
        id: 'session:bridge:humans:real-thread',
        canonicalSessionId: 'session:bridge:humans:real-thread',
        title: 'Release plan',
        preview: 'Ship it',
        updatedAtMs: 2,
        conversation: {
          ...participantSpace().sessions[0].conversation,
          id: 'session:bridge:humans:real-thread',
          canonicalSessionId: 'session:bridge:humans:real-thread',
          name: 'Release plan',
          subtitle: 'Ship it',
          messages: [{ role: 'person', sender: 'Alice', text: 'Ship it', time: '11:00' }],
        },
      },
      {
        ...participantSpace().sessions[0],
        id: 'session:bridge:humans:blank-older',
        canonicalSessionId: 'session:bridge:humans:blank-older',
        title: 'New session',
        preview: 'New session',
        updatedAtMs: 1,
        conversation: {
          ...participantSpace().sessions[0].conversation,
          id: 'session:bridge:humans:blank-older',
          canonicalSessionId: 'session:bridge:humans:blank-older',
          name: 'New session',
          subtitle: 'New session',
          messages: [],
        },
      },
    ],
  });

  assert.equal(existingBlankSessionIdForParticipantSpace(space), 'session:bridge:humans:blank-newer');
});

test('existingBlankSessionIdForParticipantSpace reuses legacy blank id families instead of creating another blank', () => {
  const space = participantSpace({
    sessions: [{
      ...participantSpace().sessions[0],
      id: 'session:direct-human:bad-blank',
      canonicalSessionId: 'session:direct-human:bad-blank',
      title: 'New session',
      preview: 'New session',
      conversation: {
        ...participantSpace().sessions[0].conversation,
        id: 'session:direct-human:bad-blank',
        canonicalSessionId: 'session:direct-human:bad-blank',
        name: 'New session',
        subtitle: 'New session',
        messages: [],
      },
    }],
  });

  assert.equal(existingBlankSessionIdForParticipantSpace(space), 'session:direct-human:bad-blank');
});

test('existingBlankSessionIdForParticipantSpace ignores New session rows that already have messages', () => {
  const space = participantSpace({
    sessions: [{
      ...participantSpace().sessions[0],
      id: 'session:bridge:humans:nonblank',
      canonicalSessionId: 'session:bridge:humans:nonblank',
      title: 'New session',
      preview: 'Hello',
      conversation: {
        ...participantSpace().sessions[0].conversation,
        id: 'session:bridge:humans:nonblank',
        canonicalSessionId: 'session:bridge:humans:nonblank',
        name: 'New session',
        subtitle: 'Hello',
        messages: [{ role: 'person', sender: 'Alice', text: 'Hello', time: '11:00' }],
      },
    }],
  });

  assert.equal(existingBlankSessionIdForParticipantSpace(space), null);
});

test('participantSpaceCanonicalSessionIds returns every canonical session in a group space', () => {
  const space = participantSpace({
    kind: 'group',
    id: 'group:session:group:root',
    sessions: [
      {
        ...participantSpace().sessions[0],
        id: 'session:group:followup',
        canonicalSessionId: 'session:group:followup',
      },
      {
        ...participantSpace().sessions[0],
        id: 'session:group:root-local-row',
        canonicalSessionId: 'session:group:root',
      },
      {
        ...participantSpace().sessions[0],
        id: 'session:group:root',
        canonicalSessionId: 'session:group:root',
      },
    ],
  });

  assert.deepEqual(participantSpaceCanonicalSessionIds(space), [
    'session:group:followup',
    'session:group:root',
  ]);
});

test('buildChatCreateGroupMetadata records stable admin and member policy', () => {
  const metadata = buildChatCreateGroupMetadata({
    creatorIdentityId: 'human:me',
    selectedContactIds: ['contact:alice', 'contact:bob'],
    selectedNames: ['Alice', 'Bob'],
    customName: 'Design crew',
    groupSpaceId: 'session:group:root',
  });

  assert.deepEqual(metadata.adminIdentityIds, ['human:me']);
  assert.deepEqual(metadata.initialContactIds, ['contact:alice', 'contact:bob']);
  assert.equal(metadata.customName, 'Design crew');
  assert.equal(metadata.groupId, 'session:group:root');
  assert.equal(metadata.groupSpaceId, 'session:group:root');
  assert.equal(metadata.memberApprovalPolicy, 'under-50-open');
});
