import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import {
  buildCloudDesktopBridgeState,
  cloudBridgeConversationId,
  cloudContactsToCanonicalIdentityRequests,
  cloudGroupParticipantContacts,
  cloudMessageToBridgeMessage,
  cloudPeerAccountIdFromConversationId,
  isCloudBridgeConversationId,
} from '../src/features/cloud/cloudBridgeState';
import { mapBridgeConversationToViewModel } from '../src/features/bridge/transcript';
import { encodeCloudAgentCancel, encodeCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { encodeCloudGroupControl } from '../src/features/cloud/cloudGroupMessages';
import { cloudContactToContact } from '../src/features/cloud/useCloudContacts';
import type { CanonicalSessionState } from '../src/kordi-app/types';

const account: CloudAccount = {
  accountId: 'acct_me',
  displayName: 'Me Cloud',
  primaryEmail: 'me@example.com',
  avatarUrl: null,
  nodeId: 'node_me',
  passwordSet: true,
};

const peer = cloudContactToContact({
  accountId: 'acct_peer',
  displayName: 'Peer Person',
  avatarUrl: null,
  nodeId: 'node_peer',
  createdAt: '2026-05-11T00:00:00Z',
});

const message: CloudMessage = {
  messageId: 'msg_1',
  fromAccountId: 'acct_peer',
  toAccountId: 'acct_me',
  body: 'hello from cloud',
  createdAt: '2026-05-11T10:00:00Z',
  deliveredAt: null,
  readAt: null,
  direction: 'incoming',
};

test('cloud bridge conversation ids use normal bridge ids with cloud host sentinel', () => {
  assert.equal(cloudBridgeConversationId('acct_peer'), 'bridge:cloud:acct_peer:person');
  assert.equal(cloudBridgeConversationId('acct_peer', 'kordi-desktop'), 'bridge:cloud:acct_peer');
  assert.equal(cloudPeerAccountIdFromConversationId('bridge:cloud:acct_peer:person'), 'acct_peer');
  assert.equal(cloudPeerAccountIdFromConversationId('bridge:cloud:acct_peer'), 'acct_peer');
  assert.equal(isCloudBridgeConversationId('bridge:local:node:person'), false);
});

test('cloud group participant contacts include non-contact group members for mentions and sending', () => {
  const canonicalSessionState = {
    sessions: [{ id: 'session:group:1', kind: 'group', title: 'Group', status: 'active', createdByIdentityId: 'human:acct_me', createdAtMs: 1, updatedAtMs: 1 }],
    identities: [
      { id: 'human:acct_me', kind: 'human', displayName: 'Me Cloud', source: 'local', humanId: 'acct_me', avatarKey: 'seed-me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:acct_member', kind: 'human', displayName: 'Group Member', source: 'bridge', sourceHostId: 'cloud', bridgeNodeId: 'acct_member', humanId: 'acct_member', avatarKey: 'seed-member', profileImageUrl: null, createdAtMs: 1, updatedAtMs: 1 },
    ],
    participants: [
      { sessionId: 'session:group:1', identityId: 'human:acct_me', role: 'self', state: 'active', addedAtMs: 1 },
      { sessionId: 'session:group:1', identityId: 'human:acct_member', role: 'person', state: 'active', addedAtMs: 1 },
    ],
    profile: { id: 'profile', storageRoot: '/tmp', createdAtMs: 1, updatedAtMs: 1 },
    messages: [],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/canonical.sqlite3',
  } as CanonicalSessionState;

  const contacts = cloudGroupParticipantContacts({
    account,
    canonicalSessionState,
    existingPeerIds: [],
  });

  assert.deepEqual(contacts.map((contact) => ({
    id: contact.id,
    name: contact.name,
    bridgeHostId: contact.bridgeHostId,
    bridgePeerNodeId: contact.bridgePeerNodeId,
    bridgeContactStatus: contact.bridgeContactStatus,
    avatarSeed: contact.avatarSeed,
  })), [{
    id: 'cloud:acct_member',
    name: 'Group Member',
    bridgeHostId: 'cloud',
    bridgePeerNodeId: 'acct_member',
    bridgeContactStatus: 'group-member',
    avatarSeed: 'seed-member',
  }]);
});

test('cloud group members do not become direct contacts or direct chat peers', () => {
  const groupMemberContact = {
    ...cloudContactToContact({
      accountId: 'acct_member',
      displayName: 'Group Member',
      avatarUrl: null,
      nodeId: 'acct_member',
      createdAt: '2026-05-11T00:00:00Z',
    }),
    bridgeContactStatus: 'group-member',
  };
  const body = encodeCloudGroupControl({
    kind: 'group-update',
    groupId: 'session:group:one',
    groupSpaceId: 'session:group:one',
    groupTitle: 'Team',
    createdByAccountId: 'acct_peer',
    actor: { accountId: 'acct_peer', displayName: 'Peer Person', avatarUrl: null, role: 'admin' },
    participants: [
      { accountId: 'acct_me', displayName: 'Me Cloud', avatarUrl: null, role: 'person' },
      { accountId: 'acct_member', displayName: 'Group Member', avatarUrl: null, role: 'person' },
    ],
    message: null,
  });
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer, groupMemberContact],
    messagesByPeer: {
      acct_peer: [message],
      acct_member: [{
        messageId: 'msg_group_control',
        fromAccountId: 'acct_member',
        toAccountId: 'acct_me',
        body,
        createdAt: '2026-05-11T10:00:00Z',
        deliveredAt: null,
        readAt: null,
        direction: 'incoming',
      }],
    },
  });

  assert.equal(state.hosts[0]?.visiblePeers.some((visiblePeer) => visiblePeer.humanId === 'acct_member'), false);
  assert.equal(state.conversations.some((conversation) => conversation.peerNodeId === 'acct_member'), false);
  assert.equal(state.conversations.some((conversation) => conversation.peerNodeId === 'acct_peer'), true);
});

test('cloud contact identity requests preserve account ids, display names, and shared avatar seeds', () => {
  const requests = cloudContactsToCanonicalIdentityRequests({
    account: {
      ...account,
      avatarUrl: 'kordi-pixel-avatar://cloud-signup:me-seed',
    },
    contacts: [cloudContactToContact({
      accountId: 'acct_peer',
      displayName: 'Peer Person',
      avatarUrl: 'kordi-pixel-avatar://cloud-signup:peer-seed',
      nodeId: 'node_peer',
      createdAt: '2026-05-11T00:00:00Z',
    })],
    localHumanIdentityId: 'human:local',
  });

  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((request) => ({
    id: request.id,
    displayName: request.displayName,
    source: request.source,
    sourceHostId: request.sourceHostId,
    bridgeNodeId: request.bridgeNodeId,
    humanId: request.humanId,
    avatarKey: request.avatarKey,
    profileImageUrl: request.profileImageUrl,
  })), [
    {
      id: 'human:local',
      displayName: 'Me Cloud',
      source: 'local',
      sourceHostId: null,
      bridgeNodeId: null,
      humanId: 'acct_me',
      avatarKey: 'cloud-signup:me-seed',
      profileImageUrl: null,
    },
    {
      id: 'human:acct_peer',
      displayName: 'Peer Person',
      source: 'bridge',
      sourceHostId: 'cloud',
      bridgeNodeId: 'acct_peer',
      humanId: 'acct_peer',
      avatarKey: 'cloud-signup:peer-seed',
      profileImageUrl: null,
    },
  ]);
});

test('cloud contacts and messages become normal desktop bridge state', () => {
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [message] },
    activeConversationId: null,
  });

  assert.equal(state.hosts[0].id, 'cloud');
  assert.equal(state.hosts[0].visiblePeers.some((candidate) => candidate.runtime === 'person'), true);
  assert.equal(state.hosts[0].visiblePeers.some((candidate) => candidate.runtime === 'kordi-desktop' && candidate.agentId === 'cloud-agent:acct_peer'), true);
  assert.equal(state.conversations.length, 1);
  assert.equal(state.conversations[0].id, 'bridge:cloud:acct_peer:person');
  assert.equal(state.conversations[0].messages[0].direction, 'inbound');
  assert.equal(state.conversations[0].messages[0].text, 'hello from cloud');
});

test('active empty cloud conversations are materialized for the existing chat UI', () => {
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: {},
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  assert.equal(state.conversations.length, 1);
  assert.equal(state.conversations[0].messages.length, 0);
  assert.equal(state.conversations[0].title, 'Peer Person');
});

test('active cloud conversations clear unread while inactive conversations keep unread', () => {
  const activeState = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [message] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });
  const inactiveState = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [message] },
    activeConversationId: null,
  });

  assert.equal(activeState.conversations[0].unreadCount, 0);
  assert.equal(inactiveState.conversations[0].unreadCount, 1);
});

test('cloud read markers keep previously read inbound messages from becoming unread again', () => {
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [message] },
    readInboundMessageIdsByPeer: { acct_peer: new Set(['msg_1']) },
    activeConversationId: null,
  });

  assert.equal(state.conversations[0].unreadCount, 0);
});

test('cloud inbound messages with server read_at do not become unread after relaunch', () => {
  const readInbound: CloudMessage = {
    ...message,
    messageId: 'msg_inbound_read_on_server',
    fromAccountId: 'acct_peer',
    toAccountId: 'acct_me',
    body: 'already read',
    direction: 'incoming',
    readAt: '2026-05-11T12:00:00Z',
  };
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [readInbound] },
    readInboundMessageIdsByPeer: {},
    activeConversationId: null,
  });

  assert.equal(state.conversations[0].unreadCount, 0);
});

test('cloud outgoing messages render as delivered once accepted by the cloud server', () => {
  const outgoing: CloudMessage = {
    ...message,
    messageId: 'msg_outgoing',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: 'hi',
    direction: 'outgoing',
  };
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [outgoing] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  assert.equal(state.conversations[0].messages[0].deliveryState, 'delivered');
});

test('cloud cloud-agent mention requests and responses use bridge agent directions', () => {
  const request = cloudMessageToBridgeMessage(account, {
    ...message,
    messageId: 'msg_request',
    body: '@MeCloudKordi who are you?',
  });
  const response = cloudMessageToBridgeMessage(account, {
    ...message,
    messageId: 'msg_response',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: encodeCloudAgentResponse({ requestId: 'msg_request', text: 'I am Kordi.' }),
    direction: 'outgoing',
  });

  assert.equal(request.direction, 'inbound');
  assert.equal(request.requestId, 'msg_request');
  assert.equal(response.direction, 'outbound-response');
  assert.equal(response.sender, null);
  assert.equal(response.requestId, 'msg_request');
  assert.equal(response.text, 'I am Kordi.');
});

test('cloud self-agent responses keep local runtime tool details local to the owner', () => {
  const request: CloudMessage = {
    ...message,
    messageId: 'msg_self_agent_request_with_tools',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: '@MyMeCloud inspect the repo',
    direction: 'outgoing',
  };
  const response: CloudMessage = {
    ...message,
    messageId: 'msg_self_agent_response_with_tools',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: encodeCloudAgentResponse({ requestId: request.messageId, text: 'I inspected it.' }),
    direction: 'outgoing',
  };
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request, response] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
    localAgentTurnsByRequestId: {
      [request.messageId]: {
        id: 'turn_1',
        sessionId: 'cloud-agent:acct_me:acct_peer',
        prompt: 'inspect the repo',
        status: 'complete',
        message: 'Complete',
        assistantText: 'I inspected it.',
        thinkingText: 'Looking through files.',
        tools: [{ id: 'tool_1', name: 'read', status: 'completed', arguments: '{}', detail: 'Read package.json', resultText: '', liveOutput: '', isError: false }],
        completed: true,
        succeeded: true,
        error: null,
      },
    },
  });

  const bridgeResponse = state.conversations[0].messages.find((candidate) => candidate.id === response.messageId);
  assert.equal(bridgeResponse?.sender, null);
  assert.equal(bridgeResponse?.localTurn?.tools[0]?.name, 'read');

  const view = mapBridgeConversationToViewModel(state.conversations[0], state.hosts[0], 'Kordi');
  const agentMessage = view.messages.find((candidate) => candidate.role === 'owned-agent');
  assert.equal(agentMessage?.sender, 'My Kordi');
  assert.equal(agentMessage?.turn?.tools[0]?.name, 'read');
});

test('cloud first-person self-agent requests hide accidental duplicate peer responses', () => {
  const request: CloudMessage = {
    ...message,
    messageId: 'msg_first_person_request',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: '@MyKordi what is agentic?',
    direction: 'outgoing',
  };
  const validResponse: CloudMessage = {
    ...message,
    messageId: 'msg_valid_self_response',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: encodeCloudAgentResponse({ requestId: request.messageId, text: 'Agentic means acting autonomously.' }),
    direction: 'outgoing',
  };
  const invalidDuplicateResponse: CloudMessage = {
    ...message,
    messageId: 'msg_invalid_peer_response',
    fromAccountId: 'acct_peer',
    toAccountId: 'acct_me',
    body: encodeCloudAgentResponse({ requestId: request.messageId, text: 'Duplicate response.' }),
    direction: 'incoming',
  };
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request, validResponse, invalidDuplicateResponse] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  const responses = state.conversations[0].messages.filter((candidate) => candidate.requestId === request.messageId && candidate.id !== request.messageId);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].id, validResponse.messageId);
});

test('cloud remote-agent responses render with the remote owner agent identity', () => {
  const request: CloudMessage = {
    ...message,
    messageId: 'msg_remote_agent_request_label',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: '@PeerPersonKordi hi',
    direction: 'outgoing',
  };
  const response: CloudMessage = {
    ...message,
    messageId: 'msg_remote_agent_response_label',
    fromAccountId: 'acct_peer',
    toAccountId: 'acct_me',
    body: encodeCloudAgentResponse({ requestId: request.messageId, text: 'Hello.' }),
    direction: 'incoming',
  };
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request, response] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });
  const view = mapBridgeConversationToViewModel(state.conversations[0], state.hosts[0], 'Kordi');
  const agentMessage = view.messages.find((candidate) => candidate.role === 'external-agent');
  assert.equal(agentMessage?.sender, "Peer Person's Kordi");
});

test('active cloud agent conversations do not remove the contact conversation', () => {
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [message] },
    activeConversationId: 'bridge:cloud:acct_peer',
  });

  assert.equal(state.conversations.some((conversation) => conversation.id === 'bridge:cloud:acct_peer:person'), true);
  assert.equal(state.conversations.some((conversation) => conversation.id === 'bridge:cloud:acct_peer'), true);
});

test('cloud parallel agent mentions keep request-specific processing and replies', () => {
  const firstRequest: CloudMessage = {
    ...message,
    messageId: 'msg_first_agent_request',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: '@PeerPersonKordi check openclaw',
    direction: 'outgoing',
    createdAt: '2026-05-11T10:00:00Z',
  };
  const secondRequest: CloudMessage = {
    ...message,
    messageId: 'msg_second_agent_request',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: '@PeerPersonKordi are you ok?',
    direction: 'outgoing',
    createdAt: '2026-05-11T10:01:00Z',
  };
  const firstResponse: CloudMessage = {
    ...message,
    messageId: 'msg_first_agent_response',
    fromAccountId: 'acct_peer',
    toAccountId: 'acct_me',
    body: encodeCloudAgentResponse({ requestId: 'msg_first_agent_request', text: 'OpenClaw is an agent project.' }),
    direction: 'incoming',
    createdAt: '2026-05-11T10:02:00Z',
  };
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [firstRequest, secondRequest, firstResponse] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });
  const view = mapBridgeConversationToViewModel(state.conversations[0], state.hosts[0], 'Kordi');
  const firstRequestViewId = 'bridge-message:bridge:cloud:acct_peer:person:msg_first_agent_request';
  const secondRequestViewId = 'bridge-message:bridge:cloud:acct_peer:person:msg_second_agent_request';
  const firstReply = view.messages.find((candidate) => candidate.id?.includes('msg_first_agent_response'));
  const pendingReplies = view.messages.filter((candidate) => candidate.turn?.status === 'processing');

  assert.equal(firstReply?.replyToMessageId, firstRequestViewId);
  assert.equal(pendingReplies.length, 1);
  assert.equal(pendingReplies[0]?.replyToMessageId, secondRequestViewId);
  assert.deepEqual(pendingReplies[0]?.turn?.pendingBridgeAgentRequest, {
    conversationId: 'bridge:cloud:acct_peer:person',
    requestId: 'msg_second_agent_request',
  });
});

test('cloud human mentions do not start cloud-agent processing UI', () => {
  const humanMention: CloudMessage = {
    ...message,
    messageId: 'msg_human_mention',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: '@PeerPerson hi',
    direction: 'outgoing',
  };
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [humanMention] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  assert.equal(state.conversations[0].awaitingReply, false);
  assert.equal(state.conversations[0].outreach, null);
  assert.equal(state.conversations[0].messages[0].direction, 'outbound');
});

test('cloud incoming local-agent mentions expose synced processing UI', () => {
  const request: CloudMessage = {
    ...message,
    messageId: 'msg_local_agent_request',
    fromAccountId: 'acct_peer',
    toAccountId: 'acct_me',
    body: '@MeCloudKordi who are you?',
    direction: 'incoming',
  };
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  assert.equal(state.conversations[0].awaitingReply, true);
  assert.equal(state.conversations[0].outreach?.targetKind, 'bridge-agent');
  assert.equal(state.conversations[0].outreach?.bridgeRequestId, 'msg_local_agent_request');
  assert.equal(state.conversations[0].outreach?.targetAgentId, 'cloud-local-agent');
});

test('cloud outgoing self-agent mentions expose localhost-style local processing UI', () => {
  const request: CloudMessage = {
    ...message,
    messageId: 'msg_self_agent_request',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: '@MyMeCloudKordi who are you?',
    direction: 'outgoing',
  };
  const pendingState = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  assert.equal(pendingState.conversations[0].awaitingReply, true);
  assert.equal(pendingState.conversations[0].outreach?.targetKind, 'bridge-agent');
  assert.equal(pendingState.conversations[0].outreach?.bridgeRequestId, 'msg_self_agent_request');
  assert.equal(pendingState.conversations[0].outreach?.targetAgentId, 'cloud-local-agent');
  assert.equal(pendingState.conversations[0].outreach?.targetNodeId, 'acct_me');

  const answeredState = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request, {
      ...message,
      messageId: 'msg_self_agent_response',
      fromAccountId: 'acct_me',
      toAccountId: 'acct_peer',
      body: encodeCloudAgentResponse({ requestId: 'msg_self_agent_request', text: 'I am your Kordi.' }),
      direction: 'outgoing',
    }] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  assert.equal(answeredState.conversations[0].awaitingReply, false);
  assert.equal(answeredState.conversations[0].outreach, null);
  assert.equal(answeredState.conversations[0].messages[1].direction, 'outbound-response');
});

test('cloud outgoing remote-agent mentions expose localhost-style pending outreach UI', () => {
  const request: CloudMessage = {
    ...message,
    messageId: 'msg_agent_request',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: '@PeerPersonKordi who are you?',
    direction: 'outgoing',
  };
  const pendingState = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  assert.equal(pendingState.conversations[0].awaitingReply, true);
  assert.equal(pendingState.conversations[0].outreach?.targetKind, 'bridge-agent');
  assert.equal(pendingState.conversations[0].outreach?.bridgeRequestId, 'msg_agent_request');
  assert.equal(pendingState.conversations[0].outreach?.parentSessionId, null);

  const answeredState = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request, {
      ...message,
      messageId: 'msg_agent_response',
      fromAccountId: 'acct_peer',
      toAccountId: 'acct_me',
      body: encodeCloudAgentResponse({ requestId: 'msg_agent_request', text: 'I am Kordi.' }),
      direction: 'incoming',
    }] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  assert.equal(answeredState.conversations[0].awaitingReply, false);
  assert.equal(answeredState.conversations[0].outreach, null);
});

test('cloud agent cancel controls are hidden and show who cancelled the request', () => {
  const request: CloudMessage = {
    ...message,
    messageId: 'msg_cancel_request',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: '@PeerPersonKordi who are you?',
    direction: 'outgoing',
  };
  const cancel: CloudMessage = {
    ...message,
    messageId: 'msg_cancel_control',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: encodeCloudAgentCancel({ requestId: 'msg_cancel_request' }),
    direction: 'outgoing',
  };
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request, cancel] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  const view = mapBridgeConversationToViewModel(state.conversations[0], state.hosts[0], 'Kordi');

  assert.equal(state.conversations[0].awaitingReply, false);
  assert.equal(state.conversations[0].messages.length, 2);
  assert.equal(state.conversations[0].messages[0].deliveryState, 'cancelled');
  assert.equal(state.conversations[0].messages[1].deliveryState, 'cancelled');
  assert.equal(view.messages[1]?.turn?.status, 'cancelled');
  assert.equal(view.messages[1]?.turn?.assistantText, 'Request canceled by sender.');
});

test('cloud outgoing messages render as read when the peer read timestamp is present', () => {
  const readOutgoing: CloudMessage = {
    ...message,
    messageId: 'msg_read',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: 'hi',
    deliveredAt: '2026-05-11T10:00:01Z',
    readAt: '2026-05-11T10:00:02Z',
    direction: 'outgoing',
  };
  const state = buildCloudDesktopBridgeState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [readOutgoing] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  assert.equal(state.conversations[0].messages[0].deliveryState, 'read');
});
