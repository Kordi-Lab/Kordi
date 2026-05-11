import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import {
  buildCloudDesktopBridgeState,
  cloudBridgeConversationId,
  cloudMessageToBridgeMessage,
  cloudPeerAccountIdFromConversationId,
  isCloudBridgeConversationId,
} from '../src/features/cloud/cloudBridgeState';
import { mapBridgeConversationToViewModel } from '../src/features/bridge/transcript';
import { encodeCloudAgentCancel, encodeCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { cloudContactToContact } from '../src/features/cloud/useCloudContacts';

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

test('cloud incoming local-agent mentions expose synced processing UI', () => {
  const request: CloudMessage = {
    ...message,
    messageId: 'msg_local_agent_request',
    fromAccountId: 'acct_peer',
    toAccountId: 'acct_me',
    body: '@MeCloud who are you?',
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
    body: '@MyMeCloud who are you?',
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

test('cloud agent cancel controls are hidden and clear pending processing', () => {
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

  assert.equal(state.conversations[0].awaitingReply, false);
  assert.equal(state.conversations[0].messages.length, 1);
  assert.equal(state.conversations[0].messages[0].deliveryState, 'cancelled');
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
