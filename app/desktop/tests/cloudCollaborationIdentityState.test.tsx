import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import {
  buildCloudDesktopCollaborationState,
  cloudCollaborationConversationId,
  cloudDirectPersonSessionId,
  cloudMessageToCollaborationMessage,
  cloudPeerAccountIdFromConversationId,
  cloudSessionIdFromConversationId,
  isCloudCollaborationConversationId,
} from '../src/features/cloud/cloudCollaborationState';
import { mapCollaborationConversationToViewModel } from '../src/features/collaboration/transcript';
import { cloudGroupForkPayloadFromSessionMetadata } from '../src/features/cloud/cloudGroupMessages';
import { cloudContactToContact } from '../src/features/cloud/useCloudContacts';
import { cloudAgentRuntimeRouteForSession } from '../src/features/cloud/cloudAgentRuntime';
import { messageActionSourceFromMessage } from '../src/features/chat/messageActionMetadata';

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

test('cloud group fork payload is recovered from canonical fork metadata', () => {
  assert.deepEqual(cloudGroupForkPayloadFromSessionMetadata({
    fork: {
      forkedFromSessionId: 'session:group:source',
      forkedFromMessageId: 'msg:source',
      createdAtMs: 1234,
    },
  }, 'session:fork:abc'), {
    forkSessionId: 'session:fork:abc',
    parentSessionId: 'session:group:source',
    parentMessageId: 'msg:source',
    createdAtMs: 1234,
  });
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
  assert.equal(cloudPeerAccountIdFromConversationId('cloud:conversation:acct_peer:person'), 'acct_peer');
  assert.equal(cloudSessionIdFromConversationId('cloud:conversation:acct_peer:agent:session:session%3Aself'), 'session:self');
  assert.equal(cloudPeerAccountIdFromConversationId('bridge:cloud:acct_peer:person'), 'acct_peer');
  assert.equal(cloudPeerAccountIdFromConversationId('bridge:cloud:acct_peer'), 'acct_peer');
  assert.equal(cloudSessionIdFromConversationId('bridge:cloud:acct_peer:session:session%3Aself'), 'session:self');
  assert.equal(isCloudCollaborationConversationId('bridge:cloud:acct_peer:person'), true);
  assert.equal(isCloudCollaborationConversationId('bridge:local:node:person'), false);
});
