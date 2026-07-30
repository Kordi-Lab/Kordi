import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import { cloudDirectPersonSessionId } from '../src/features/cloud/cloudCollaborationState';
import { encodeCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { encodeCloudGroupControl } from '../src/features/cloud/cloudGroupMessages';
import { cloudContactToContact } from '../src/features/cloud/useCloudContacts';
import {
  shouldRunLocalCloudAgentForCloudMessage,
  cloudAgentResponseExistsForRequest,
  cloudGroupAgentResponseExistsForRequest,
  cloudFallbackClaimErrorIsRetryable,
  cloudFallbackRunClaimsForMessages,
} from '../src/features/cloud/useCloudCollaborationState';

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

test('cloud fallback claim retries transient presence, invite, and network races', () => {
  for (const code of ['network_error', 'owner_online', 'agent_not_available', 'rate_limited', 'server_error']) {
    assert.equal(cloudFallbackClaimErrorIsRetryable({ code }), true, code);
  }
  for (const code of ['provider_auth_not_configured', 'requester_mismatch', 'invalid_session']) {
    assert.equal(cloudFallbackClaimErrorIsRetryable({ code }), false, code);
  }
});

test('cloud local group owner agent detects existing Cloud fallback response for request', () => {
  const groupId = 'session:group:one';
  const participants = [
    { accountId: 'acct_me', displayName: 'Me Cloud', avatarUrl: null, role: 'person' as const },
    { accountId: 'acct_peer', displayName: 'Peer Person', avatarUrl: null, role: 'admin' as const },
  ];
  const response = encodeCloudGroupControl({
    kind: 'group-message',
    groupId,
    groupSpaceId: groupId,
    groupTitle: null,
    createdByAccountId: 'acct_peer',
    actor: participants[0],
    participants,
    message: {
      id: 'cloudrunmsg_group_answered',
      senderAccountId: 'acct_me',
      text: 'Already answered by Cloud.',
      createdAtMs: 2_000,
      senderKind: 'agent',
      senderDisplayName: "Me Cloud's Kordi",
      deliveryState: 'complete',
      requestId: 'msg:ui:group_request_answered_by_cloud',
      replyToMessageId: 'msg:ui:group_request_answered_by_cloud',
    },
  });

  assert.equal(cloudGroupAgentResponseExistsForRequest({
    localAccountId: 'acct_me',
    requestMessageId: 'msg:ui:group_request_answered_by_cloud',
    messages: [{
      ...message,
      messageId: 'cloudrunmsg_group_answered_row',
      fromAccountId: 'acct_me',
      toAccountId: 'acct_peer',
      body: response,
      direction: 'outgoing',
      sessionId: groupId,
    }],
  }), true);
});

test('cloud local owner agent detects existing Cloud fallback response for request', () => {
  const request: CloudMessage = {
    ...message,
    messageId: 'msg_request_answered_by_cloud',
    fromAccountId: 'acct_peer',
    toAccountId: 'acct_me',
    body: '@MeCloudKordi can you see the chathiotory?',
    direction: 'incoming',
    createdAt: new Date().toISOString(),
  };
  const cloudResponse: CloudMessage = {
    ...message,
    messageId: 'cloudrunmsg_answered',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: encodeCloudAgentResponse({ requestId: request.messageId, text: 'Already answered by Cloud.' }),
    direction: 'outgoing',
    createdAt: new Date().toISOString(),
  };

  assert.equal(cloudAgentResponseExistsForRequest({
    account,
    requestMessageId: request.messageId,
    peerMessages: [request, cloudResponse],
  }), true);
  assert.equal(shouldRunLocalCloudAgentForCloudMessage({
    account,
    peerId: 'acct_peer',
    message: request,
    peerMessages: [request, cloudResponse],
  }), false);
});

test('cloud outgoing remote-agent mentions produce Cloud fallback run claims', () => {
  const request: CloudMessage = {
    ...message,
    messageId: 'msg_agent_request_claim',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: '@PeerPersonKordi what is todays weather',
    direction: 'outgoing',
    createdAt: new Date().toISOString(),
  };

  assert.deepEqual(cloudFallbackRunClaimsForMessages({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request] },
  }), [{
    requestMessageId: 'msg_agent_request_claim',
    sessionId: cloudDirectPersonSessionId('acct_me', 'acct_peer'),
    ownerAccountId: 'acct_peer',
    requesterAccountId: 'acct_me',
    prompt: 'what is todays weather',
    idempotencyKey: 'cloud-agent-fallback:msg_agent_request_claim:acct_peer',
  }]);
});
