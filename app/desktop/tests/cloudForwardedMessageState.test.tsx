import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import {
  buildCloudCollaborationConversation,
  buildCloudDesktopCollaborationState,
  cloudCollaborationConversationId,
  cloudDirectPersonSessionId,
  cloudMessageToCollaborationMessage,
} from '../src/features/cloud/cloudCollaborationState';
import { mapCollaborationConversationToViewModel } from '../src/features/collaboration/transcript';
import { encodeCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { encodeCloudDirectMessageEnvelope, parseCloudDirectMessageEnvelope } from '../src/features/cloud/cloudDirectMessages';
import { cloudContactToContact } from '../src/features/cloud/useCloudContacts';
import { cloudGroupMessageTargetsLocalAgent, shouldRunLocalCloudAgentForCloudMessage, cloudFallbackRunClaimsForMessages } from '../src/features/cloud/useCloudCollaborationState';

const account: CloudAccount = {
  accountId: 'acct_me',
  displayName: 'Me Cloud',
  primaryEmail: 'me@example.com',
  avatarUrl: null,
  avatar: cloudAccountAvatarFixture,
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

test('direct Cloud forwarded envelopes survive bridge transcript mapping', () => {
  const source = {
    sourceSessionId: 'session:source',
    sourceMessageId: 'msg:source',
    senderLabel: 'Peer Person',
    textPreview: '@MyKordi test',
    attachmentCount: 0,
    timeLabel: '10:42',
  };
  const body = encodeCloudDirectMessageEnvelope({
    schemaVersion: 1,
    kind: 'message',
    text: '@MyKordi test',
    messageAction: {
      schemaVersion: 1,
      kind: 'forward',
      source,
    },
  });
  const bridgeMessage = cloudMessageToCollaborationMessage(account, {
    messageId: 'msg_cloud_forward',
    fromAccountId: account.accountId,
    toAccountId: 'acct_peer',
    body,
    createdAt: '2026-06-08T04:53:47.645Z',
    deliveredAt: null,
    readAt: null,
    direction: 'outgoing',
    sessionId: cloudDirectPersonSessionId(account.accountId, 'acct_peer'),
    attachments: [],
  }, peer);
  const view = mapCollaborationConversationToViewModel({
    id: cloudCollaborationConversationId('acct_peer', 'person'),
    peerNodeId: 'acct_peer',
    peerRuntime: 'person',
    peerDisplayName: 'Peer Person',
    peerOwnerName: 'Peer Person',
    messages: [bridgeMessage],
    unreadCount: 0,
    updatedAtMs: Date.parse('2026-06-08T04:53:47.645Z'),
  }, undefined, 'Kordi');

  assert.equal(bridgeMessage.messageAction?.kind, 'forward');
  assert.equal(bridgeMessage.requestId, null);
  assert.equal(view.messages[0]?.messageAction?.kind, 'forward');
  assert.equal(view.messages[0]?.messageAction?.source.senderLabel, 'Peer Person');
});

test('forwarded mentions stay inert across direct execution and pending UI', () => {
  const body = encodeCloudDirectMessageEnvelope({
    schemaVersion: 1,
    kind: 'message',
    text: '@KordiProjectDriver test',
    messageAction: {
      schemaVersion: 1,
      kind: 'forward',
      source: {
        sourceSessionId: 'session:source',
        sourceMessageId: 'msg:source',
        senderLabel: 'Alex Morgan',
        textPreview: '@KordiProjectDriver test',
        attachmentCount: 0,
      },
    },
    targetCloudAgentId: 'cloud_agent_project',
    targetCloudAgentName: 'Kordi Project Driver',
    targetCloudAgentOwnerAccountId: account.accountId,
  });
  const forwardedMessage: CloudMessage = {
    messageId: 'msg_forwarded_agent_mention',
    fromAccountId: 'acct_peer',
    toAccountId: account.accountId,
    body,
    createdAt: new Date().toISOString(),
    deliveredAt: null,
    readAt: null,
    direction: 'incoming',
    sessionId: cloudDirectPersonSessionId(account.accountId, 'acct_peer'),
    attachments: [],
  };

  assert.equal(shouldRunLocalCloudAgentForCloudMessage({
    account,
    peerId: 'acct_peer',
    message: forwardedMessage,
    peerMessages: [forwardedMessage],
  }), false);

  const state = buildCloudDesktopCollaborationState({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [forwardedMessage] },
    activeConversationId: cloudCollaborationConversationId('acct_peer', 'person'),
  });
  assert.equal(state.conversations[0]?.awaitingReply, false);
  assert.equal(state.conversations[0]?.outreach, null);
  assert.equal(state.conversations[0]?.messages.length, 1);

  const outgoingBody = encodeCloudDirectMessageEnvelope({
    ...parseCloudDirectMessageEnvelope(body)!,
    targetCloudAgentOwnerAccountId: 'acct_peer',
  });
  const outgoingForward = {
    ...forwardedMessage,
    fromAccountId: account.accountId,
    toAccountId: 'acct_peer',
    body: outgoingBody,
    direction: 'outgoing' as const,
  };
  const nextRequest = {
    ...outgoingForward,
    messageId: 'msg_after_forward',
    body: encodeCloudDirectMessageEnvelope({
      schemaVersion: 1,
      kind: 'message',
      text: '@PeerPersonKordi answer only this',
      targetCloudAgentId: 'cloud_agent_project',
      targetCloudAgentName: 'Peer Person Kordi',
      targetCloudAgentOwnerAccountId: 'acct_peer',
    }),
    createdAt: new Date(Date.now() + 1_000).toISOString(),
  };
  const claims = cloudFallbackRunClaimsForMessages({
    account,
    contacts: [peer],
    messagesByPeer: { acct_peer: [outgoingForward, nextRequest] },
  });
  assert.equal(claims.length, 1);
  assert.match(claims[0]?.prompt ?? '', /answer only this/);
  assert.doesNotMatch(claims[0]?.prompt ?? '', /KordiProjectDriver test/);
});

test('forwarded group mentions never target a local agent', () => {
  const forwardedAction = {
    schemaVersion: 1 as const,
    kind: 'forward' as const,
    source: {
      sourceSessionId: 'session:source',
      sourceMessageId: 'msg:source',
      senderLabel: 'Alex Morgan',
      textPreview: '@MyKordi test',
      attachmentCount: 0,
    },
  };
  assert.equal(cloudGroupMessageTargetsLocalAgent({
    id: 'msg:forwarded',
    senderAccountId: account.accountId,
    text: '@MyKordi test',
    createdAtMs: Date.now(),
    messageAction: forwardedAction,
  }, account), false);
  assert.equal(cloudGroupMessageTargetsLocalAgent({
    id: 'msg:quoted',
    senderAccountId: account.accountId,
    text: '@MyKordi test',
    createdAtMs: Date.now(),
    messageAction: { ...forwardedAction, kind: 'quote' },
  }, account), true);
});

test('direct Cloud hosted shared-agent requests and responses keep the shared agent display name', () => {
  const requestBody = encodeCloudDirectMessageEnvelope({
    schemaVersion: 1,
    kind: 'message',
    text: '@KordiProjectDriver hii',
    targetCloudAgentId: 'cloud_agent_project',
    targetCloudAgentName: 'Kordi Project Driver',
    targetCloudAgentOwnerAccountId: 'acct_peer',
    targetCloudAgentOwnerName: 'Peer Person',
  });
  const request: CloudMessage = {
    messageId: 'msg_direct_project_request',
    fromAccountId: account.accountId,
    toAccountId: 'acct_peer',
    body: requestBody,
    createdAt: '2026-06-23T01:41:34.463Z',
    deliveredAt: null,
    readAt: null,
    direction: 'outgoing',
    sessionId: cloudDirectPersonSessionId(account.accountId, 'acct_peer'),
    attachments: [],
  };
  const response: CloudMessage = {
    messageId: 'msg_direct_project_response',
    fromAccountId: 'acct_peer',
    toAccountId: account.accountId,
    body: encodeCloudAgentResponse({
      requestId: request.messageId,
      text: 'Hi! How can I help?',
      deliveryState: 'complete',
    }),
    createdAt: '2026-06-23T01:41:47.467Z',
    deliveredAt: null,
    readAt: null,
    direction: 'incoming',
    sessionId: cloudDirectPersonSessionId(account.accountId, 'acct_peer'),
    attachments: [],
  };

  const conversation = buildCloudCollaborationConversation({
    account,
    contact: peer,
    messages: [request, response],
    runtime: 'person',
  });
  const responseMessage = conversation.messages.find((message) => message.id === response.messageId);

  assert.equal(responseMessage?.sender, 'Kordi Project Driver');
  assert.equal(responseMessage?.requestId, request.messageId);
  assert.equal(conversation.outreach, null);

  const pendingConversation = buildCloudCollaborationConversation({
    account,
    contact: peer,
    messages: [request],
    runtime: 'person',
  });

  const pendingProcessing = pendingConversation.messages.find((message) => message.id === `cloud-agent-processing:${request.messageId}`);
  const pendingView = mapCollaborationConversationToViewModel(pendingConversation, undefined, 'Kordi');
  const pendingViewProcessing = pendingView.messages.find((message) => message.turn?.status === 'processing');

  assert.equal(pendingConversation.outreach?.targetDisplayName, 'Kordi Project Driver');
  assert.equal(pendingProcessing?.sender, 'Kordi Project Driver');
  assert.equal(pendingViewProcessing?.sender, 'Kordi Project Driver');
});

test('direct Cloud forwarded headers rewrite legacy Me labels to the remote human profile name', () => {
  const body = encodeCloudDirectMessageEnvelope({
    schemaVersion: 1,
    kind: 'message',
    text: 'h every',
    messageAction: {
      schemaVersion: 1,
      kind: 'forward',
      source: {
        sourceSessionId: 'session:legacy',
        sourceMessageId: 'msg:legacy',
        senderLabel: 'Me',
        textPreview: 'legacy source',
        attachmentCount: 0,
        timeLabel: '13:46',
      },
    },
  });
  const bridgeMessage = cloudMessageToCollaborationMessage(account, {
    messageId: 'msg_legacy_me_forward',
    fromAccountId: 'acct_peer',
    toAccountId: account.accountId,
    body,
    createdAt: '2026-06-08T04:53:47.645Z',
    deliveredAt: null,
    readAt: null,
    direction: 'incoming',
    sessionId: cloudDirectPersonSessionId(account.accountId, 'acct_peer'),
    attachments: [],
  }, peer);
  const view = mapCollaborationConversationToViewModel({
    id: cloudCollaborationConversationId('acct_peer', 'person'),
    peerNodeId: 'acct_peer',
    peerRuntime: 'person',
    peerDisplayName: 'Peer Person',
    peerOwnerName: 'Peer Person',
    canonicalSessionId: cloudDirectPersonSessionId(account.accountId, 'acct_peer'),
    messages: [bridgeMessage],
    unreadCount: 0,
    updatedAtMs: Date.parse('2026-06-08T04:53:47.645Z'),
    identity: {
      sourceHostId: 'cloud',
      localHumanId: account.accountId,
      localHumanName: account.displayName,
      localAgentId: 'cloud-local-agent',
      localAgentName: 'My Kordi',
      remoteHumanId: 'acct_peer',
      remoteHumanName: 'Peer Person',
      remoteAgentId: 'cloud-agent:acct_peer',
      remoteAgentName: "Peer Person's Kordi",
    },
  }, undefined, 'Kordi');

  assert.equal(view.messages[0]?.messageAction?.source.senderLabel, 'Peer Person');
  assert.equal(view.messages[0]?.sourceMessage?.senderLabel, 'Peer Person');
});

test('direct Cloud forwarded headers rewrite legacy My Kordi labels to the remote agent profile name', () => {
  const body = encodeCloudDirectMessageEnvelope({
    schemaVersion: 1,
    kind: 'message',
    text: 'agent source',
    messageAction: {
      schemaVersion: 1,
      kind: 'forward',
      source: {
        sourceSessionId: 'session:legacy-agent',
        sourceMessageId: 'msg:legacy-agent',
        senderLabel: 'My Kordi',
        textPreview: 'legacy agent source',
        attachmentCount: 0,
        timeLabel: '13:46',
      },
    },
  });
  const bridgeMessage = cloudMessageToCollaborationMessage(account, {
    messageId: 'msg_legacy_agent_forward',
    fromAccountId: 'acct_peer',
    toAccountId: account.accountId,
    body,
    createdAt: '2026-06-08T04:53:47.645Z',
    deliveredAt: null,
    readAt: null,
    direction: 'incoming',
    sessionId: cloudDirectPersonSessionId(account.accountId, 'acct_peer'),
    attachments: [],
  }, peer);
  const view = mapCollaborationConversationToViewModel({
    id: cloudCollaborationConversationId('acct_peer', 'person'),
    peerNodeId: 'acct_peer',
    peerRuntime: 'person',
    peerDisplayName: 'Peer Person',
    peerOwnerName: 'Peer Person',
    canonicalSessionId: cloudDirectPersonSessionId(account.accountId, 'acct_peer'),
    messages: [bridgeMessage],
    unreadCount: 0,
    updatedAtMs: Date.parse('2026-06-08T04:53:47.645Z'),
    identity: {
      sourceHostId: 'cloud',
      localHumanId: account.accountId,
      localHumanName: account.displayName,
      localAgentId: 'cloud-local-agent',
      localAgentName: 'My Kordi',
      remoteHumanId: 'acct_peer',
      remoteHumanName: 'Peer Person',
      remoteAgentId: 'cloud-agent:acct_peer',
      remoteAgentName: "Peer Person's Kordi",
    },
  }, undefined, 'Kordi');

  assert.equal(view.messages[0]?.messageAction?.source.senderLabel, "Peer Person's Kordi");
  assert.equal(view.messages[0]?.sourceMessage?.senderLabel, "Peer Person's Kordi");
});
