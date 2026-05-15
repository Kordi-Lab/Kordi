import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildChatCreateAgentOptions,
  buildChatAgentSessionMetadata,
  buildChatAgentSessionKind,
  buildChatCreateGroupBridgeInviteParticipants,
  buildChatCreateGroupBridgeInviteTargets,
  buildChatCreateGroupMetadata,
  buildChatCreateGroupPersonOptions,
  buildChatGroupBridgeUpdateParticipants,
  buildChatGroupBridgeUpdateTargets,
  buildChatCreatePersonOptions,
  buildChatCreatePeopleContactLookup,
  buildParticipantSpaceContinuationMetadata,
  canCreateGroup,
  chatSessionIdForAgentStart,
  chatSessionIdForParticipantSpaceContinuation,
  chatSessionIdForPersonStart,
  existingSessionIdForPersonStart,
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

test('cloud contact ids from the create dialog resolve to bridge-shaped contacts for group creation', () => {
  const cloudContact = contact({
    id: 'bridge-peer-person:acct_peer:acct_peer',
    name: 'Cloud Peer',
    bridgeHostId: 'cloud',
    bridgePeerNodeId: 'acct_peer',
    bridgeHumanId: 'acct_peer',
    bridgeContactStatus: 'accepted',
  });

  const lookup = buildChatCreatePeopleContactLookup([cloudContact]);

  assert.equal(lookup.get('bridge-peer-person:acct_peer:acct_peer'), cloudContact);
  assert.equal(lookup.get('cloud:acct_peer'), cloudContact);
});

test('buildChatCreatePersonOptions includes only approved Bridge contacts', () => {
  const options = buildChatCreatePersonOptions([
    contact({ id: 'contact:approved', name: 'Approved', bridgeHostId: 'host-1', bridgePeerNodeId: 'kd_approved', bridgeContactStatus: 'contact' }),
    contact({ id: 'contact:approved-request', name: 'Approved request', bridgeHostId: 'host-1', bridgePeerNodeId: 'kd_approved_request', bridgeContactStatus: 'approved' }),
    contact({ id: 'contact:cloud-accepted', name: 'Cloud accepted', bridgeHostId: 'cloud', bridgePeerNodeId: 'acct_peer', bridgeContactStatus: 'accepted' }),
    contact({ id: 'contact:pending', name: 'Pending', bridgeHostId: 'host-1', bridgePeerNodeId: 'kd_pending', bridgeContactStatus: 'pending' }),
    contact({ id: 'contact:visible', name: 'Visible', bridgeHostId: 'host-1', bridgePeerNodeId: 'kd_visible', bridgeContactStatus: 'none' }),
    contact({ id: 'contact:local-only', name: 'Local' }),
  ]);

  assert.deepEqual(options.map((option) => option.id), ['contact:approved', 'contact:approved-request', 'contact:cloud-accepted', 'contact:local-only']);
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

test('person create flow can still derive a direct-person session id for new local pairs', () => {
  assert.equal(chatSessionIdForPersonStart('first-id'), 'session:direct-person:first-id');
  assert.equal(chatSessionIdForPersonStart('second-id'), 'session:direct-person:second-id');
});

test('existingSessionIdForPersonStart reuses the existing human pair session', () => {
  const alice = contact({ id: 'contact:alice', name: 'Alice', bridgeHumanId: 'human-alice' });
  const conversations = [
    chatConversation({
      id: 'session:direct-person:older',
      canonicalSessionId: 'session:direct-person:older',
      type: 'person',
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:human-alice', name: 'Alice', kind: 'human', role: 'person', source: 'local', humanId: 'human-alice', avatarKey: 'alice' },
      ],
      _updatedAtMs: 1,
    }),
    chatConversation({
      id: 'session:direct-person:newer',
      canonicalSessionId: 'session:direct-person:newer',
      type: 'person',
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:human-alice', name: 'Alice', kind: 'human', role: 'person', source: 'local', humanId: 'human-alice', avatarKey: 'alice' },
      ],
      _updatedAtMs: 3,
    }),
    chatConversation({
      id: 'session:direct-person:bob',
      canonicalSessionId: 'session:direct-person:bob',
      type: 'person',
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'local', avatarKey: 'bob' },
      ],
      _updatedAtMs: 5,
    }),
  ];

  assert.equal(existingSessionIdForPersonStart(alice, conversations), 'session:direct-person:newer');
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

test('group create options require approved bridge contacts', () => {
  const options = buildChatCreateGroupPersonOptions([
    contact({ id: 'contact:approved', name: 'Approved', bridgeHostId: 'host-1', bridgePeerNodeId: 'kd_approved', bridgeContactStatus: 'contact' }),
    contact({ id: 'contact:pending', name: 'Pending', bridgeHostId: 'host-1', bridgePeerNodeId: 'kd_pending', bridgeContactStatus: 'pending' }),
    contact({ id: 'contact:visible', name: 'Visible', bridgeHostId: 'host-1', bridgePeerNodeId: 'kd_visible', bridgeContactStatus: 'none' }),
    contact({ id: 'contact:local-only', name: 'Local' }),
  ]);

  assert.deepEqual(options.map((option) => option.id), ['contact:approved', 'contact:local-only']);
});

test('group create bridge invites target only approved bridge contacts', () => {
  const targets = buildChatCreateGroupBridgeInviteTargets([
    contact({ id: 'contact:alice', name: 'Alice', bridgeHostId: 'host-1', bridgePeerNodeId: 'kd_alice', bridgeHumanId: 'kh_alice', bridgeContactStatus: 'contact' }),
    contact({ id: 'contact:bob', name: 'Bob', owner: 'Bobby', bridgeHostId: 'host-1', bridgePeerNodeId: 'kd_bob', bridgeHumanId: 'kh_bob', bridgeContactStatus: 'pending' }),
    contact({ id: 'contact:local-only', name: 'Local' }),
  ]);

  assert.deepEqual(targets, [
    { hostId: 'host-1', nodeId: 'kd_alice', displayName: 'Alice', ownerName: 'Alice', humanId: 'kh_alice' },
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
    { identityId: 'human:kh_me', displayName: 'Testuser2', role: 'admin', bridgeNodeId: 'kd_me', humanId: 'kh_me', agentId: null },
    { identityId: 'human:kh_user1', displayName: 'Testuser1', role: 'person', bridgeNodeId: 'kd_user1', humanId: 'kh_user1', agentId: null },
    { identityId: 'human:kh_user3', displayName: 'Testuser3', role: 'person', bridgeNodeId: 'kd_user3', humanId: 'kh_user3', agentId: null },
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
    { hostId: 'host-1', nodeId: 'kd_user1', displayName: 'Testuser1', ownerName: 'Testuser1', humanId: 'kh_user1' },
    { hostId: 'host-1', nodeId: 'kd_user3', displayName: 'Testuser3', ownerName: 'Testuser3', humanId: 'kh_user3' },
  ]);
  assert.deepEqual(buildChatGroupBridgeUpdateParticipants({ participants, adminIdentityIds: ['human:me'] }), [
    { identityId: 'human:me', displayName: 'Testuser2', role: 'admin', bridgeNodeId: 'kd_me', humanId: 'kh_me', agentId: null, avatarKey: 'me', profileImageUrl: null },
    { identityId: 'human:user1', displayName: 'Testuser1', role: 'person', bridgeNodeId: 'kd_user1', humanId: 'kh_user1', agentId: null, avatarKey: 'user1', profileImageUrl: null },
    { identityId: 'human:user3', displayName: 'Testuser3', role: 'person', bridgeNodeId: 'kd_user3', humanId: 'kh_user3', agentId: null, avatarKey: 'user3', profileImageUrl: null },
  ]);
});

test('group update participant metadata preserves profile avatars', () => {
  const participants = [
    { id: 'human:acct_a', name: 'Cloud A', kind: 'human', role: 'person', source: 'bridge', bridgeHostId: 'cloud', bridgeNodeId: 'acct_a', humanId: 'acct_a', avatarKey: 'acct_a', profileImageUrl: 'https://example.com/a.png' },
  ] satisfies Conversation['canonicalParticipants'];

  assert.deepEqual(buildChatGroupBridgeUpdateParticipants({ participants, adminIdentityIds: [] }), [
    { identityId: 'human:acct_a', displayName: 'Cloud A', role: 'person', bridgeNodeId: 'acct_a', humanId: 'acct_a', agentId: null, avatarKey: 'acct_a', profileImageUrl: 'https://example.com/a.png' },
  ]);
});

test('group update targets keep same-name cloud humans separate by account id', () => {
  const participants = [
    { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
    { id: 'human:acct_a', name: 'Shu Yang', kind: 'human', role: 'person', source: 'bridge', bridgeHostId: 'cloud', bridgeNodeId: 'acct_a', humanId: 'acct_a', avatarKey: 'acct_a' },
    { id: 'human:acct_b', name: 'Shu Yang', kind: 'human', role: 'person', source: 'bridge', bridgeHostId: 'cloud', bridgeNodeId: 'acct_b', humanId: 'acct_b', avatarKey: 'acct_b' },
  ] satisfies Conversation['canonicalParticipants'];

  assert.deepEqual(buildChatGroupBridgeUpdateTargets({ actorIdentityId: 'human:me', participants }), [
    { hostId: 'cloud', nodeId: 'acct_a', displayName: 'Shu Yang', ownerName: 'Shu Yang', humanId: 'acct_a' },
    { hostId: 'cloud', nodeId: 'acct_b', displayName: 'Shu Yang', ownerName: 'Shu Yang', humanId: 'acct_b' },
  ]);
  assert.deepEqual(buildChatGroupBridgeUpdateParticipants({ participants, adminIdentityIds: ['human:me'] }), [
    { identityId: 'human:me', displayName: 'Me', role: 'admin', bridgeNodeId: null, humanId: null, agentId: null, avatarKey: 'me', profileImageUrl: null },
    { identityId: 'human:acct_a', displayName: 'Shu Yang', role: 'person', bridgeNodeId: 'acct_a', humanId: 'acct_a', agentId: null, avatarKey: 'acct_a', profileImageUrl: null },
    { identityId: 'human:acct_b', displayName: 'Shu Yang', role: 'person', bridgeNodeId: 'acct_b', humanId: 'acct_b', agentId: null, avatarKey: 'acct_b', profileImageUrl: null },
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
