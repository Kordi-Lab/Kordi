import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import { buildCloudDesktopCollaborationState } from '../src/features/cloud/cloudCollaborationState';
import { mapCollaborationConversationToViewModel } from '../src/features/collaboration/transcript';
import { encodeCloudAgentCancel, encodeCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { encodeCloudGroupControl } from '../src/features/cloud/cloudGroupMessages';
import { cloudContactToContact } from '../src/features/cloud/useCloudContacts';
import {
  cloudGroupAgentProcessingSlotForResponse,
  cloudGroupIncomingMessageAlreadyApplied,
  cloudGroupNativeContextMessages,
  cloudFallbackRunClaimsForMessages,
} from '../src/features/cloud/useCloudCollaborationState';
import { buildCloudMessageIndex } from '../src/features/cloud/cloudMessageIndex';
import type { CanonicalSessionMessage } from '../src/kordi-app/types';

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

test('cloud outgoing group remote-agent mentions produce Cloud fallback run claims', () => {
  const groupId = 'session:group:one';
  const peerThree = cloudContactToContact({
    accountId: 'acct_three',
    displayName: 'Three Person',
    avatarUrl: null,
    nodeId: 'node_three',
    createdAt: '2026-05-11T00:00:00Z',
  });
  const participants = [
    { accountId: 'acct_me', displayName: 'Me Cloud', avatarUrl: null, role: 'admin' as const },
    { accountId: 'acct_peer', displayName: 'Peer Person', avatarUrl: null, role: 'person' as const },
    { accountId: 'acct_three', displayName: 'Three Person', avatarUrl: null, role: 'person' as const },
  ];
  const previousBody = encodeCloudGroupControl({
    kind: 'group-message',
    groupId,
    groupSpaceId: groupId,
    groupTitle: null,
    createdByAccountId: 'acct_me',
    actor: participants[0],
    participants,
    message: {
      id: 'msg:ui:group_previous',
      senderAccountId: 'acct_three',
      text: 'hii every one',
      createdAtMs: 1_000,
      senderKind: 'human',
    },
  });
  const requestBody = encodeCloudGroupControl({
    kind: 'group-message',
    groupId,
    groupSpaceId: groupId,
    groupTitle: null,
    createdByAccountId: 'acct_me',
    actor: participants[0],
    participants,
    message: {
      id: 'msg:ui:group_request',
      senderAccountId: 'acct_me',
      text: '@PeerPersonKordi say hello to everyone',
      createdAtMs: 2_000,
      senderKind: 'human',
    },
  });
  const previous: CloudMessage = {
    ...message,
    messageId: 'msg_group_previous_cloud_row',
    fromAccountId: 'acct_three',
    toAccountId: 'acct_me',
    body: previousBody,
    direction: 'incoming',
    sessionId: groupId,
  };
  const requestToOwner: CloudMessage = {
    ...message,
    messageId: 'msg_group_request_owner_row',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: requestBody,
    direction: 'outgoing',
    sessionId: groupId,
  };
  const requestToParticipant: CloudMessage = {
    ...requestToOwner,
    messageId: 'msg_group_request_three_row',
    toAccountId: 'acct_three',
  };

  assert.deepEqual(cloudFallbackRunClaimsForMessages({
    account,
    contacts: [peer, peerThree],
    messagesByPeer: {
      acct_peer: [requestToOwner],
      acct_three: [previous, requestToParticipant],
    },
  }), [{
    requestMessageId: 'msg:ui:group_request',
    sessionId: groupId,
    ownerAccountId: 'acct_peer',
    requesterAccountId: 'acct_me',
    prompt: 'Group chat history:\nThree Person: hii every one\n\nCurrent request:\nsay hello to everyone',
    idempotencyKey: 'cloud-agent-fallback-group:session:group:one:msg:ui:group_request:acct_peer',
  }]);
});

test('cloud forwarded group mentions do not produce fallback run claims', () => {
  const groupId = 'session:group:forwarded';
  const participants = [
    { accountId: 'acct_me', displayName: 'Me Cloud', avatarUrl: null, role: 'admin' as const },
    { accountId: 'acct_peer', displayName: 'Peer Person', avatarUrl: null, role: 'person' as const },
  ];
  const requestBody = encodeCloudGroupControl({
    kind: 'group-message',
    groupId,
    groupSpaceId: groupId,
    groupTitle: null,
    createdByAccountId: 'acct_me',
    actor: participants[0],
    participants,
    message: {
      id: 'msg:ui:group_forwarded_request',
      senderAccountId: 'acct_me',
      text: '@PeerPersonKordi test',
      createdAtMs: 2_000,
      senderKind: 'human',
      messageAction: {
        schemaVersion: 1,
        kind: 'forward',
        source: {
          sourceSessionId: 'session:source',
          sourceMessageId: 'msg:source',
          senderLabel: 'Shu Yang',
          textPreview: '@PeerPersonKordi test',
          attachmentCount: 0,
        },
      },
    },
  });
  const request: CloudMessage = {
    ...message,
    messageId: 'msg_group_forwarded_cloud_row',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: requestBody,
    direction: 'outgoing',
    sessionId: groupId,
  };
  const nextRequest: CloudMessage = {
    ...request,
    messageId: 'msg_group_after_forward_cloud_row',
    body: encodeCloudGroupControl({
      kind: 'group-message',
      groupId,
      groupSpaceId: groupId,
      groupTitle: null,
      createdByAccountId: 'acct_me',
      actor: participants[0],
      participants,
      message: {
        id: 'msg:ui:group_after_forward_request',
        senderAccountId: 'acct_me',
        text: '@PeerPersonKordi answer only this',
        createdAtMs: 3_000,
        senderKind: 'human',
      },
    }),
  };

  const claims = cloudFallbackRunClaimsForMessages({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request, nextRequest] },
  });
  assert.equal(claims.length, 1);
  assert.match(claims[0]?.prompt ?? '', /answer only this/);
  assert.doesNotMatch(claims[0]?.prompt ?? '', /PeerPersonKordi test/);
  const index = buildCloudMessageIndex(account.accountId, { acct_peer: [request, nextRequest] });
  assert.deepEqual(cloudGroupNativeContextMessages({
    groupRows: index.groupRows,
    groupId,
    requestMessageId: 'msg:ui:group_after_forward_request',
    requestCreatedAtMs: 3_000,
  }), []);
});

test('cloud outgoing remote-agent mention claims include prior direct chat history', () => {
  const firstRequest: CloudMessage = {
    ...message,
    messageId: 'msg_weather_request',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: '@PeerPersonKordi what is xuzhu city weather',
    direction: 'outgoing',
    createdAt: '2026-05-28T16:04:50.000Z',
  };
  const firstResponse: CloudMessage = {
    ...message,
    messageId: 'cloudrunmsg_weather_response',
    fromAccountId: 'acct_peer',
    toAccountId: 'acct_me',
    body: encodeCloudAgentResponse({ requestId: 'msg_weather_request', text: 'I think you mean Xuzhou city, China.' }),
    direction: 'incoming',
    createdAt: '2026-05-28T17:17:00.000Z',
  };
  const secondRequest: CloudMessage = {
    ...message,
    messageId: 'msg_check_again',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: '@PeerPersonKordi check ahain',
    direction: 'outgoing',
    createdAt: '2026-05-28T22:30:07.000Z',
  };

  const claims = cloudFallbackRunClaimsForMessages({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [firstRequest, firstResponse, secondRequest] },
  });

  assert.equal(claims.length, 1);
  assert.equal(claims[0].requestMessageId, 'msg_check_again');
  assert.match(claims[0].prompt, /Conversation history:/);
  assert.match(claims[0].prompt, /Me: what is xuzhu city weather/);
  assert.match(claims[0].prompt, /Peer Person's Kordi: I think you mean Xuzhou city, China\./);
  assert.match(claims[0].prompt, /Current request:\ncheck ahain$/);
});

test('cloud outgoing remote-agent mentions expose localhost-style pending outreach UI', () => {
  const request: CloudMessage = {
    ...message,
    messageId: 'msg_agent_request',
    fromAccountId: 'acct_me',
    toAccountId: 'acct_peer',
    body: '@PeerPersonKordi who are you?',
    direction: 'outgoing',
    createdAt: new Date().toISOString(),
  };
  const pendingState = buildCloudDesktopCollaborationState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  assert.equal(pendingState.conversations[0].awaitingReply, true);
  assert.equal(pendingState.conversations[0].outreach?.targetKind, 'agent');
  assert.equal(pendingState.conversations[0].outreach?.sourceRequestId, 'msg_agent_request');
  assert.equal(pendingState.conversations[0].outreach?.parentSessionId, null);

  const answeredState = buildCloudDesktopCollaborationState({
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

test('cloud group terminal responses reuse an existing peer processing slot', () => {
  const processing = {
    id: 'msg:cloud-agent-processing:msg_request:acct_peer',
    sessionId: 'session:group',
    senderIdentityId: 'agent:cloud:acct_peer',
    senderRole: 'external-agent',
    messageKind: 'agent-turn',
    contentText: 'processing...',
    content: { sender: "Peer's Kordi", requestId: 'msg_request', deliveryState: 'processing' },
    parentMessageId: 'msg_request',
    status: 'processing',
    sequenceNum: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
    contentHash: null,
    sourceTransport: 'cloud-group-agent',
    sourceEventId: 'cloud-group-agent:msg:cloud-agent-processing:msg_request:acct_peer',
  } as CanonicalSessionMessage;
  const unrelatedOtherAgentProcessing = {
    ...processing,
    id: 'msg:cloud-agent-processing:msg_request:acct_other',
    senderIdentityId: 'agent:cloud:acct_other',
  } as CanonicalSessionMessage;

  assert.equal(
    cloudGroupAgentProcessingSlotForResponse(
      [unrelatedOtherAgentProcessing, processing],
      'session:group',
      'msg_request',
      'acct_peer',
    )?.id,
    processing.id,
  );
});

test('cloud group terminal envelopes replace a synced processing slot', () => {
  const processing = {
    id: 'msg:cloud-agent-processing:msg_request:acct_me',
    sessionId: 'session:group',
    senderIdentityId: 'agent:cloud:acct_me',
    senderRole: 'external-agent',
    messageKind: 'agent-turn',
    contentText: 'processing...',
    content: { requestId: 'msg_request', deliveryState: 'processing' },
    parentMessageId: 'msg_request',
    status: 'processing',
    sequenceNum: 2,
    createdAtMs: 2,
    updatedAtMs: 2,
    sourceTransport: 'cloud-group-agent',
  } as CanonicalSessionMessage;
  const complete = {
    ...processing,
    contentText: 'Received: 111 👋',
    content: { requestId: 'msg_request', deliveryState: 'complete' },
    status: 'sent',
  } as CanonicalSessionMessage;

  assert.equal(cloudGroupIncomingMessageAlreadyApplied(null, 'complete'), false);
  assert.equal(cloudGroupIncomingMessageAlreadyApplied(processing, 'processing'), true);
  assert.equal(cloudGroupIncomingMessageAlreadyApplied(processing, 'complete'), false);
  assert.equal(cloudGroupIncomingMessageAlreadyApplied(processing, 'failed'), false);
  assert.equal(cloudGroupIncomingMessageAlreadyApplied(complete, 'complete'), true);
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
  const state = buildCloudDesktopCollaborationState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [request, cancel] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  const view = mapCollaborationConversationToViewModel(state.conversations[0], state.hosts[0], 'Kordi');

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
  const state = buildCloudDesktopCollaborationState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [readOutgoing] },
    activeConversationId: 'bridge:cloud:acct_peer:person',
  });

  assert.equal(state.conversations[0].messages[0].deliveryState, 'read');
});

