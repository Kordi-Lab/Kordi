import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import { buildCloudDesktopCollaborationState } from '../src/features/cloud/cloudCollaborationState';
import { mapCollaborationConversationToViewModel } from '../src/features/collaboration/transcript';
import { encodeCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { encodeCloudDirectMessageEnvelope } from '../src/features/cloud/cloudDirectMessages';
import { cloudContactToContact } from '../src/features/cloud/useCloudContacts';
import { shouldRunLocalCloudAgentForCloudMessage, cloudAgentRunStatusAlreadyOwnsRequest } from '../src/features/cloud/useCloudCollaborationState';

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

test('cloud direct hosted-agent requests hide duplicate owner responses for the same request', () => {
  const request: CloudMessage = {
    ...message,
    messageId: 'msg_direct_hosted_duplicate_request',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: encodeCloudDirectMessageEnvelope({
      schemaVersion: 1,
      kind: 'message',
      text: '@KordiProjectDriver who are you',
      targetCloudAgentId: 'cloud_agent_project',
      targetCloudAgentName: 'Kordi Project Driver',
      targetCloudAgentOwnerAccountId: 'acct_peer',
      targetCloudAgentOwnerName: 'Peer Person',
    }),
    direction: 'outgoing',
  };
  const firstResponse: CloudMessage = {
    ...message,
    messageId: 'msg_direct_hosted_duplicate_response_a',
    fromAccountId: 'acct_peer',
    toAccountId: 'acct_me',
    body: encodeCloudAgentResponse({ requestId: request.messageId, text: 'First response.' }),
    direction: 'incoming',
    createdAt: '2026-06-23T03:28:28.000Z',
  };
  const secondResponse: CloudMessage = {
    ...message,
    messageId: 'msg_direct_hosted_duplicate_response_b',
    fromAccountId: 'acct_peer',
    toAccountId: 'acct_me',
    body: encodeCloudAgentResponse({ requestId: request.messageId, text: 'Second duplicate response.' }),
    direction: 'incoming',
    createdAt: '2026-06-23T03:28:29.000Z',
  };
  const state = buildCloudDesktopCollaborationState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request, firstResponse, secondResponse] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  const responses = state.conversations[0].messages.filter((candidate) => candidate.requestId === request.messageId && candidate.id !== request.messageId);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].id, firstResponse.messageId);
  assert.equal(responses[0].sender, 'Kordi Project Driver');
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
  const state = buildCloudDesktopCollaborationState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request, response] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });
  const view = mapCollaborationConversationToViewModel(state.conversations[0], state.hosts[0], 'Kordi');
  const agentMessage = view.messages.find((candidate) => candidate.role === 'external-agent');
  assert.equal(agentMessage?.sender, "Peer Person's Kordi");
});

test('active cloud agent bridge placeholders are not materialized as duplicate sessions', () => {
  const state = buildCloudDesktopCollaborationState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [message] },
    activeConversationId: 'bridge:cloud:acct_peer',
  });

  assert.equal(state.conversations.some((conversation) => conversation.id === 'cloud:conversation:acct_peer:person'), true);
  assert.equal(state.conversations.some((conversation) => conversation.id === 'cloud:conversation:acct_peer:agent'), false);
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
    createdAt: new Date().toISOString(),
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
  const state = buildCloudDesktopCollaborationState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [firstRequest, secondRequest, firstResponse] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });
  const view = mapCollaborationConversationToViewModel(state.conversations[0], state.hosts[0], 'Kordi');
  const firstRequestViewId = 'collaboration-message:cloud:conversation:acct_peer:person:msg_first_agent_request';
  const secondRequestViewId = 'collaboration-message:cloud:conversation:acct_peer:person:msg_second_agent_request';
  const firstReply = view.messages.find((candidate) => candidate.id?.includes('msg_first_agent_response'));
  const pendingReplies = view.messages.filter((candidate) => candidate.turn?.status === 'processing');

  assert.equal(firstReply?.replyToMessageId, firstRequestViewId);
  assert.equal(pendingReplies.length, 1);
  assert.equal(pendingReplies[0]?.replyToMessageId, secondRequestViewId);
  assert.deepEqual(pendingReplies[0]?.turn?.pendingCollaborationAgentRequest, {
    conversationId: 'cloud:conversation:acct_peer:person',
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
  const state = buildCloudDesktopCollaborationState({
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
  const state = buildCloudDesktopCollaborationState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  assert.equal(state.conversations[0].awaitingReply, true);
  assert.equal(state.conversations[0].outreach?.targetKind, 'agent');
  assert.equal(state.conversations[0].outreach?.sourceRequestId, 'msg_local_agent_request');
  assert.equal(state.conversations[0].outreach?.targetAgentId, 'cloud-local-agent');
});

test('cloud local agent runner ignores same-account self-agent sync messages', () => {
  const selfRequest: CloudMessage = {
    ...message,
    messageId: 'msg_synced_self_request',
    fromAccountId: account.accountId,
    toAccountId: account.accountId,
    body: 'Can anyone relate?',
    direction: 'outgoing',
    createdAt: new Date().toISOString(),
    sessionId: 'local-self-session',
  };
  const incomingMention: CloudMessage = {
    ...message,
    messageId: 'msg_incoming_local_agent_request',
    fromAccountId: 'acct_peer',
    toAccountId: account.accountId,
    body: '@MeCloudKordi who are you?',
    direction: 'incoming',
    createdAt: new Date().toISOString(),
  };

  assert.equal(shouldRunLocalCloudAgentForCloudMessage({
    account,
    peerId: account.accountId,
    message: selfRequest,
    peerMessages: [selfRequest],
  }), false);
  assert.equal(shouldRunLocalCloudAgentForCloudMessage({
    account,
    peerId: 'acct_peer',
    message: incomingMention,
    peerMessages: [incomingMention],
  }), true);
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
  const pendingState = buildCloudDesktopCollaborationState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  assert.equal(pendingState.conversations[0].awaitingReply, true);
  assert.equal(pendingState.conversations[0].outreach?.targetKind, 'agent');
  assert.equal(pendingState.conversations[0].outreach?.sourceRequestId, 'msg_self_agent_request');
  assert.equal(pendingState.conversations[0].outreach?.targetAgentId, 'cloud-local-agent');
  assert.equal(pendingState.conversations[0].outreach?.targetNodeId, 'acct_me');

  const answeredState = buildCloudDesktopCollaborationState({
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

test('cloud outgoing remote-agent mentions stay reachable through Cloud fallback after timeout', () => {
  const request: CloudMessage = {
    ...message,
    messageId: 'msg_agent_request_offline',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: '@PeerPersonKordi hello',
    direction: 'outgoing',
    createdAt: '2026-05-11T08:00:00Z',
  };
  const state = buildCloudDesktopCollaborationState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  assert.equal(state.conversations[0].awaitingReply, true);
  assert.equal(state.conversations[0].outreach?.targetKind, 'agent');
  assert.equal(state.conversations[0].outreach?.sourceRequestId, 'msg_agent_request_offline');
  const offlineMessage = state.conversations[0].messages.find((candidate) => candidate.id === 'cloud-agent-offline:msg_agent_request_offline');
  assert.equal(offlineMessage, undefined);
  const processingMessage = state.conversations[0].messages.find((candidate) => candidate.id === 'cloud-agent-processing:msg_agent_request_offline');
  assert.equal(processingMessage?.deliveryState, 'processing');

  const view = mapCollaborationConversationToViewModel(state.conversations[0], state.hosts[0], 'Kordi');
  const pendingTurn = view.messages.find((candidate) => candidate.role === 'external-agent')?.turn;
  assert.equal(pendingTurn?.status, 'processing');
});

test('cloud local owner agent treats active Cloud fallback run as already owned by Cloud', () => {
  assert.equal(cloudAgentRunStatusAlreadyOwnsRequest('queued'), true);
  assert.equal(cloudAgentRunStatusAlreadyOwnsRequest('leased'), true);
  assert.equal(cloudAgentRunStatusAlreadyOwnsRequest('running'), true);
  assert.equal(cloudAgentRunStatusAlreadyOwnsRequest('completed'), true);
  assert.equal(cloudAgentRunStatusAlreadyOwnsRequest('failed'), false);
  assert.equal(cloudAgentRunStatusAlreadyOwnsRequest('cancelled'), false);
});

