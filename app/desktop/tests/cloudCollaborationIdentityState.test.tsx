import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import {
  buildCloudDesktopCollaborationState,
  cloudCollaborationConversationId,
  cloudDirectPersonSessionId,
  cloudSystemAgentConversationId,
  cloudMessageToCollaborationMessage,
  cloudPeerAccountIdFromConversationId,
  cloudSessionIdFromConversationId,
  cloudSystemAgentSessionId,
  isCloudCollaborationConversationId,
} from '../src/features/cloud/cloudCollaborationState';
import { mapCollaborationConversationToViewModel } from '../src/features/collaboration/transcript';
import { cloudContactToContact } from '../src/features/cloud/useCloudContacts';
import { cloudAgentRuntimeRouteForSession } from '../src/features/cloud/cloudAgentRuntime';
import { messageActionSourceFromMessage } from '../src/features/chat/messageActionMetadata';
import { buildParticipantSpaces, filterParticipantSpaces } from '../src/features/chat/participantSpaces';
import { encodeCloudDirectMessageEnvelope } from '../src/features/cloud/cloudDirectMessages';
import { encodeCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { KORDI_SUPPORT_AVATAR_URL } from '../src/features/support/supportIdentity';

const account: CloudAccount = {
  accountId: 'acct_me',
  displayName: 'Me Cloud',
  primaryEmail: 'me@example.com',
  avatarUrl: 'kordi-avatar://dicebear-rust-10.6.0-styles-10.5.0/lorelei/account_seed?version=1',
  avatar: {
    entityType: 'human',
    entityId: 'acct_me',
    source: 'generated',
    style: 'lorelei',
    seed: 'account_seed',
    rendererVersion: 'dicebear-rust-10.6.0-styles-10.5.0',
    uploadedAsset: null,
    version: 1,
    updatedAt: '2026-08-19T00:00:00Z',
  },
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

function builtInSupportContact() {
  return cloudContactToContact({
    contactId: 'cloud-system:kordi-support',
    contactKind: 'system_agent',
    accountId: 'acct_support',
    displayName: 'Kordi Support',
    subtitle: 'Ask questions or suggest improvements',
    avatarUrl: null,
    nodeId: null,
    createdAt: '2026-08-04T00:00:00Z',
    locked: true,
    targetCloudAgentId: 'cloud_agent_kordi_support',
    targetCloudAgentName: 'Kordi Support',
    targetCloudAgentOwnerAccountId: 'acct_support',
    targetCloudAgentOwnerName: 'Kordi',
    supportTicketEnabled: true,
  });
}

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

test('direct Cloud forwards use real local display name as source sender label', () => {
  const bridgeMessage = cloudMessageToCollaborationMessage(account, {
    messageId: 'msg_plain_source',
    fromAccountId: account.accountId,
    toAccountId: 'acct_peer',
    body: 'source text',
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
  const source = messageActionSourceFromMessage(view.messages[0]!, view.canonicalSessionId!);

  assert.equal(view.messages[0]?.sender, 'Me');
  assert.equal(source?.senderLabel, 'Me Cloud');
});

test('direct Cloud forwards use real remote human name as source sender label', () => {
  const bridgeMessage = cloudMessageToCollaborationMessage(account, {
    messageId: 'msg_remote_source',
    fromAccountId: 'acct_peer',
    toAccountId: account.accountId,
    body: 'remote text',
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
  const source = messageActionSourceFromMessage(view.messages[0]!, view.canonicalSessionId!);

  assert.equal(view.messages[0]?.sender, 'Peer Person');
  assert.equal(source?.senderLabel, 'Peer Person');
});

test('direct Cloud forwards use real local agent owner name as source sender label', () => {
  const view = mapCollaborationConversationToViewModel({
    id: cloudCollaborationConversationId(account.accountId, 'kordi-desktop', 'session:self'),
    peerNodeId: account.accountId,
    peerRuntime: 'kordi-desktop',
    peerDisplayName: 'My Kordi',
    peerOwnerName: account.displayName,
    canonicalSessionId: 'session:self',
    messages: [{
      id: 'msg_agent_source',
      direction: 'outbound_response',
      sender: 'My Kordi',
      text: 'Agent answer',
      timeLabel: '10:43',
      timestampMs: Date.parse('2026-06-08T04:53:48.645Z'),
      deliveryState: 'complete',
      attachments: [],
      localTurn: null,
    }],
    unreadCount: 0,
    updatedAtMs: Date.parse('2026-06-08T04:53:48.645Z'),
    identity: {
      sourceHostId: 'cloud',
      localHumanId: account.accountId,
      localHumanName: account.displayName,
      localAgentId: 'cloud-local-agent',
      localAgentName: 'My Kordi',
      remoteHumanId: account.accountId,
      remoteHumanName: account.displayName,
      remoteAgentId: 'cloud-local-agent',
      remoteAgentName: 'My Kordi',
    },
  }, undefined, 'Kordi');
  const source = messageActionSourceFromMessage(view.messages[0]!, view.canonicalSessionId!);

  assert.equal(view.messages[0]?.sender, 'My Kordi');
  assert.equal(source?.senderLabel, "Me Cloud's Kordi");
});

test('cloud agent runtime routes fall back to current composer route for unconfigured cloud sessions', () => {
  const route = cloudAgentRuntimeRouteForSession({}, 'cloud-agent:acct_me:session:group:one', {
    model: 'anthropic/claude-opus-4-7',
    authProvider: 'anthropic',
    authChoice: 'o_auth',
    thinking: 'medium',
  });

  assert.deepEqual(route, {
    model: 'anthropic/claude-opus-4-7',
    authProvider: 'anthropic',
    authChoice: 'o_auth',
    thinking: 'medium',
  });
});

test('cloud bridge state ignores poisoned localhost bridge state instead of merging it', () => {
  const cloudState = buildCloudDesktopCollaborationState({
    account,
    contacts: [peer],
    messagesByPeer: {},
    readInboundMessageIdsByPeer: {},
    activeConversationId: null,
    localAgentTurnsByRequestId: {},
    localAgentRuntimeRoute: null,
    cloudSessionTitlesById: {},
    hiddenCloudSessionIds: new Set(),
    suppressUnscopedSelfAgentConversation: false,
  });

  assert.deepEqual(cloudState.hosts.map((host) => host.id), ['cloud']);
  assert.equal(cloudState.conversations.every((conversation) => conversation.hostId === 'cloud'), true);
  assert.equal(cloudState.hosts[0]?.agents[0]?.profileImageUrl, null);
});






test('cloud bridge messages preserve resolved attachment local paths for inline previews', () => {
  const mapped = cloudMessageToCollaborationMessage(account, {
    ...message,
    attachments: [{
      attachmentId: 'att_1',
      name: 'Screenshot.png',
      kind: 'image',
      mimeType: 'image/png',
      sizeBytes: 68 * 1024,
      localPath: '/tmp/kordi-cache/Screenshot.png',
    }],
  }, peer);

  assert.equal(mapped.attachments?.[0]?.attachmentId, 'att_1');
  assert.equal(mapped.attachments?.[0]?.localPath, '/tmp/kordi-cache/Screenshot.png');
});

test('Cloud collaboration ids are neutral while legacy Bridge ids remain readable', () => {
  assert.equal(cloudCollaborationConversationId('acct_peer'), 'cloud:conversation:acct_peer:person');
  assert.equal(cloudCollaborationConversationId('acct_peer', 'kordi-desktop'), 'cloud:conversation:acct_peer:agent');
  assert.equal(
    cloudCollaborationConversationId('acct_peer', 'kordi-desktop', 'session:self'),
    'cloud:conversation:acct_peer:agent:session:session%3Aself',
  );
  assert.equal(cloudDirectPersonSessionId('acct_me', 'acct_peer'), 'session:direct-person:acct_me:acct_peer');
  assert.equal(cloudDirectPersonSessionId('acct_peer', 'acct_me'), 'session:direct-person:acct_me:acct_peer');
  assert.equal(
    cloudSystemAgentConversationId('acct_me', 'acct_support', 'cloud_agent_kordi_support'),
    'cloud:conversation:acct_support:agent:session:session%3Adirect-system-agent%3Aacct_me%3Acloud_agent_kordi_support',
  );
  assert.equal(cloudPeerAccountIdFromConversationId('cloud:conversation:acct_peer:person'), 'acct_peer');
  assert.equal(cloudSessionIdFromConversationId('cloud:conversation:acct_peer:agent:session:session%3Aself'), 'session:self');
  assert.equal(cloudPeerAccountIdFromConversationId('bridge:cloud:acct_peer:person'), 'acct_peer');
  assert.equal(cloudPeerAccountIdFromConversationId('bridge:cloud:acct_peer'), 'acct_peer');
  assert.equal(cloudSessionIdFromConversationId('bridge:cloud:acct_peer:session:session%3Aself'), 'session:self');
  assert.equal(isCloudCollaborationConversationId('bridge:cloud:acct_peer:person'), true);
  assert.equal(isCloudCollaborationConversationId('bridge:local:node:person'), false);
});

test('a fresh account keeps Kordi Support available without synthesizing chat activity', () => {
  const state = buildCloudDesktopCollaborationState({
    account,
    contacts: [builtInSupportContact()],
    messagesByPeer: {},
    activeConversationId: null,
  });

  assert.deepEqual(state.conversations, []);
  assert.equal(
    state.hosts[0]?.visiblePeers.some((entry) => (
      entry.agentId === 'cloud_agent_kordi_support'
      && entry.isContact
    )),
    true,
  );
});

test('selecting Kordi Support opens one empty conversation in the Contact channel', () => {
  const activeConversationId = cloudSystemAgentConversationId(
    account.accountId,
    'acct_support',
    'cloud_agent_kordi_support',
  );
  const state = buildCloudDesktopCollaborationState({
    account,
    contacts: [builtInSupportContact()],
    messagesByPeer: {},
    activeConversationId,
  });

  assert.equal(state.conversations.length, 1);
  assert.equal(state.conversations[0]?.id, activeConversationId);
  assert.equal(state.conversations[0]?.messages.length, 0);
  const supportView = mapCollaborationConversationToViewModel(
    state.conversations[0]!,
    state.hosts[0],
    'Kordi',
  );
  assert.equal(supportView.type, 'person');
  assert.equal(supportView.supportTicketEnabled, true);
  const spaces = buildParticipantSpaces([supportView]);
  assert.deepEqual(filterParticipantSpaces(spaces, '', 'contact').map((space) => space.title), ['Kordi Support']);
  assert.deepEqual(filterParticipantSpaces(spaces, '', 'agent'), []);
});

test('opening the support owner as a person does not synthesize a Support chat', () => {
  const supportOwner = cloudContactToContact({
    accountId: 'acct_support',
    displayName: 'Support Owner',
    avatarUrl: null,
    nodeId: null,
    createdAt: '2026-08-04T00:00:00Z',
  });
  const state = buildCloudDesktopCollaborationState({
    account,
    contacts: [builtInSupportContact(), supportOwner],
    messagesByPeer: {},
    activeConversationId: cloudCollaborationConversationId('acct_support', 'person'),
  });

  assert.equal(state.conversations.length, 1);
  assert.equal(state.conversations[0]?.peerRuntime, 'person');
  assert.equal(state.conversations[0]?.supportTicketEnabled, false);
});

test('the built-in support agent keeps a stable thread separate from its owner human', () => {
  const supportOwner = cloudContactToContact({
    accountId: 'acct_support',
    displayName: 'Support Owner',
    avatarUrl: null,
    nodeId: null,
    createdAt: '2026-08-04T00:00:00Z',
  });
  const supportAgent = builtInSupportContact();
  const supportSessionId = cloudSystemAgentSessionId(account.accountId, 'cloud_agent_kordi_support');
  const request: CloudMessage = {
    messageId: 'msg_support_request',
    fromAccountId: account.accountId,
    toAccountId: 'acct_support',
    body: encodeCloudDirectMessageEnvelope({
      schemaVersion: 1,
      kind: 'message',
      text: 'How do groups work?',
      targetCloudAgentId: 'cloud_agent_kordi_support',
      targetCloudAgentName: 'Kordi Support',
      targetCloudAgentOwnerAccountId: 'acct_support',
      targetCloudAgentOwnerName: 'Kordi',
    }),
    sessionId: supportSessionId,
    createdAt: '2026-08-04T10:00:00Z',
    deliveredAt: '2026-08-04T10:00:00Z',
    readAt: null,
    direction: 'outgoing',
    attachments: [],
  };
  const response: CloudMessage = {
    messageId: 'msg_support_response',
    fromAccountId: 'acct_support',
    toAccountId: account.accountId,
    body: encodeCloudAgentResponse({ requestId: request.messageId, text: 'Open the group, then choose a session.' }),
    sessionId: supportSessionId,
    createdAt: '2026-08-04T10:00:01Z',
    deliveredAt: '2026-08-04T10:00:01Z',
    readAt: null,
    direction: 'incoming',
    attachments: [],
  };
  const humanMessage: CloudMessage = {
    messageId: 'msg_support_owner_human',
    fromAccountId: 'acct_support',
    toAccountId: account.accountId,
    body: 'A normal message from the account owner',
    sessionId: cloudDirectPersonSessionId(account.accountId, 'acct_support'),
    createdAt: '2026-08-04T10:00:02Z',
    deliveredAt: '2026-08-04T10:00:02Z',
    readAt: null,
    direction: 'incoming',
    attachments: [],
  };

  const state = buildCloudDesktopCollaborationState({
    account,
    contacts: [supportAgent, supportOwner],
    messagesByPeer: { acct_support: [request, response, humanMessage] },
    readInboundMessageIdsByPeer: {},
    activeConversationId: null,
    localAgentTurnsByRequestId: {},
    localAgentRuntimeRoute: null,
    cloudSessionTitlesById: {},
    hiddenCloudSessionIds: new Set(),
    suppressUnscopedSelfAgentConversation: false,
  });
  const supportConversation = state.conversations.find((conversation) => (
    conversation.identity?.remoteAgentId === 'cloud_agent_kordi_support'
  ));
  const ownerConversation = state.conversations.find((conversation) => (
    conversation.peerRuntime === 'person' && conversation.peerNodeId === 'acct_support'
  ));

  assert.ok(supportConversation);
  assert.equal(supportConversation.supportTicketEnabled, true);
  assert.equal(supportConversation.canonicalSessionId, supportSessionId);
  assert.deepEqual(supportConversation.messages.map((entry) => entry.id), [
    'msg_support_request',
    'msg_support_response',
  ]);
  const supportView = mapCollaborationConversationToViewModel(
    supportConversation,
    state.hosts[0],
    'Kordi',
  );
  assert.equal(supportView.name, 'Kordi Support');
  assert.equal(supportView.type, 'person');
  assert.equal(supportView.directness, 'Person chat');
  assert.deepEqual(supportView.participants, ['Me', 'Kordi Support']);
  assert.equal(supportView.messages[1]?.sender, 'Kordi Support');
  assert.equal(supportView.messages[1]?.role, 'person');
  assert.equal(supportView.messages[1]?.senderType, 'human');
  assert.equal(supportView.messages[1]?.turn, undefined);
  assert.equal(supportView.messages[1]?.supportContactResponse, true);
  assert.equal(supportView.collaborationTarget?.runtime, 'kordi-desktop');
  assert.equal(supportView.collaborationTarget?.agentId, 'cloud_agent_kordi_support');
  assert.equal(supportView.profileImageUrl, KORDI_SUPPORT_AVATAR_URL);
  assert.equal(supportView.participantProfileImageUrls?.['Kordi Support'], KORDI_SUPPORT_AVATAR_URL);
  assert.equal(supportView.messages[1]?.senderProfileImageUrl, KORDI_SUPPORT_AVATAR_URL);
  const supportSpaces = buildParticipantSpaces([supportView]);
  assert.deepEqual(filterParticipantSpaces(supportSpaces, '', 'contact').map((space) => space.title), ['Kordi Support']);
  assert.deepEqual(filterParticipantSpaces(supportSpaces, '', 'agent'), []);
  assert.ok(ownerConversation);
  assert.deepEqual(ownerConversation.messages.map((entry) => entry.id), ['msg_support_owner_human']);
  assert.equal(
    state.hosts[0]?.visiblePeers.filter((entry) => entry.agentId === 'cloud_agent_kordi_support').length,
    1,
  );
});
