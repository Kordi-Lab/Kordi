import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildCloudBridgeConversation, buildCloudBridgeHost, buildCloudDesktopBridgeState, cloudBridgeConversationId } from '../src/features/cloud/cloudBridgeState';
import { encodeCloudDirectMessageEnvelope, parseCloudDirectMessageEnvelope } from '../src/features/cloud/cloudDirectMessages';
import { cloudContactToContact } from '../src/features/cloud/useCloudContacts';
import { cloudBridgeSendBodyForConversation } from '../src/features/cloud/useCloudBridgeState';
import { encodeCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import type { Contact } from '../src/kordi-app/types';

test('cloud support contact maps to a locked hosted agent contact', () => {
  const contact = cloudContactToContact({
    contactId: 'cloud-system:kordi-support',
    contactKind: 'system_agent',
    accountId: 'acct_support_owner',
    displayName: 'Kordi Support',
    subtitle: 'Ask questions or suggest improvements',
    avatarUrl: null,
    nodeId: null,
    createdAt: '2026-06-26T00:00:00Z',
    locked: true,
    targetCloudAgentId: 'cloud_agent_kordi_support',
    targetCloudAgentName: 'Kordi Support',
    targetCloudAgentOwnerAccountId: 'acct_support_owner',
    targetCloudAgentOwnerName: 'Kordi',
  });

  assert.equal(contact.id, 'cloud-system:kordi-support');
  assert.equal(contact.name, 'Kordi Support');
  assert.equal(contact.entityType, 'agent');
  assert.equal(contact.bridgePeerNodeId, 'acct_support_owner');
  assert.equal(contact.bridgePeerRuntime, 'agent');
  assert.equal(contact.locked, true);
  assert.equal(contact.systemContact, true);
  assert.equal(contact.targetCloudAgentId, 'cloud_agent_kordi_support');
  assert.equal(contact.targetCloudAgentOwnerAccountId, 'acct_support_owner');
});

test('support agent conversation id uses the support owner and agent runtime', () => {
  assert.equal(
    cloudBridgeConversationId('acct_support_owner', 'kordi-desktop'),
    'bridge:cloud:acct_support_owner',
  );
});

test('support agent direct message envelope carries hosted target metadata', () => {
  const body = encodeCloudDirectMessageEnvelope({
    schemaVersion: 1,
    kind: 'message',
    text: 'How do reminders work?',
    targetCloudAgentId: 'cloud_agent_kordi_support',
    targetCloudAgentName: 'Kordi Support',
    targetCloudAgentOwnerAccountId: 'acct_support_owner',
    targetCloudAgentOwnerName: 'Kordi',
  });
  const parsed = parseCloudDirectMessageEnvelope(body);
  assert.equal(parsed?.text, 'How do reminders work?');
  assert.equal(parsed?.targetCloudAgentId, 'cloud_agent_kordi_support');
  assert.equal(parsed?.targetCloudAgentOwnerAccountId, 'acct_support_owner');
});

function cloudAccountFixture(): CloudAccount {
  return {
    accountId: 'acct_user',
    primaryEmail: 'user@example.com',
    displayName: 'Me',
    avatarUrl: null,
    nodeId: null,
    createdAt: '2026-06-26T00:00:00Z',
    updatedAt: '2026-06-26T00:00:00Z',
  };
}

function supportContactFixture(): Contact {
  return {
    id: 'cloud-system:kordi-support',
    name: 'Kordi Support',
    initials: 'KS',
    classType: 'other-users-agents',
    entityType: 'agent',
    subtitle: 'Ask questions or suggest improvements',
    bridges: ['cloud'],
    status: 'online',
    discoverableOn: ['cloud'],
    detail: 'Official Kordi support contact.',
    owner: 'Kordi Support',
    bridgeHostId: 'cloud',
    bridgePeerNodeId: 'acct_support_owner',
    bridgePeerRuntime: 'agent',
    bridgeHumanId: 'acct_support_owner',
    bridgeAgentId: 'cloud_agent_kordi_support',
    systemContact: true,
    locked: true,
    targetCloudAgentId: 'cloud_agent_kordi_support',
    targetCloudAgentName: 'Kordi Support',
    targetCloudAgentOwnerAccountId: 'acct_support_owner',
    targetCloudAgentOwnerName: 'Kordi',
  };
}

test('support contact bridge host exposes only the hosted support agent peer', () => {
  const host = buildCloudBridgeHost({
    accountId: 'acct_user',
    primaryEmail: 'user@example.com',
    displayName: 'User',
    avatarUrl: null,
    nodeId: null,
    createdAt: '2026-06-26T00:00:00Z',
    updatedAt: '2026-06-26T00:00:00Z',
  }, [supportContactFixture()]);

  assert.equal(host.visiblePeers.length, 1);
  assert.equal(host.visiblePeers[0]?.displayName, 'Kordi Support');
  assert.equal(host.visiblePeers[0]?.agentId, 'cloud_agent_kordi_support');
  assert.equal(host.visiblePeers[0]?.runtime, 'kordi-desktop');
});

function cloudMessage(overrides: Partial<CloudMessage>): CloudMessage {
  return {
    messageId: 'msg-default',
    fromAccountId: 'acct_user',
    toAccountId: 'acct_support_owner',
    body: 'hello',
    direction: 'outgoing',
    deliveredAt: '2026-06-26T23:10:00Z',
    readAt: null,
    createdAt: '2026-06-26T23:10:00Z',
    sessionId: 'session:direct-person:acct_support_owner:acct_user',
    attachments: [],
    ...overrides,
  };
}

test('support direct conversation keeps the user request visible before the support reply', () => {
  const requestBody = encodeCloudDirectMessageEnvelope({
    schemaVersion: 1,
    kind: 'message',
    text: 'hihi',
    targetCloudAgentId: 'cloud_agent_kordi_support',
    targetCloudAgentName: 'Kordi Support',
    targetCloudAgentOwnerAccountId: 'acct_support_owner',
    targetCloudAgentOwnerName: 'Kordi',
  });
  const conversation = buildCloudBridgeConversation({
    account: cloudAccountFixture(),
    contact: supportContactFixture(),
    runtime: 'kordi-desktop',
    messages: [
      cloudMessage({ messageId: 'msg-user-request', body: requestBody }),
      cloudMessage({
        messageId: 'msg-support-response',
        fromAccountId: 'acct_support_owner',
        toAccountId: 'acct_user',
        direction: 'incoming',
        body: encodeCloudAgentResponse({ requestId: 'msg-user-request', text: 'Hi! How can I help?' }),
        createdAt: '2026-06-26T23:10:01Z',
        deliveredAt: '2026-06-26T23:10:01Z',
      }),
    ],
  });

  assert.deepEqual(conversation.messages.map((message) => message.text), ['hihi', 'Hi! How can I help?']);
  assert.equal(conversation.messages[0]?.direction, 'outbound');
  assert.equal(conversation.messages[1]?.direction, 'inbound-response');
});

test('support direct messages materialize as the hosted agent conversation, not a duplicate person thread', () => {
  const requestBody = encodeCloudDirectMessageEnvelope({
    schemaVersion: 1,
    kind: 'message',
    text: 'hihi',
    targetCloudAgentId: 'cloud_agent_kordi_support',
    targetCloudAgentName: 'Kordi Support',
    targetCloudAgentOwnerAccountId: 'acct_support_owner',
    targetCloudAgentOwnerName: 'Kordi',
  });
  const state = buildCloudDesktopBridgeState({
    account: cloudAccountFixture(),
    contacts: [supportContactFixture()],
    messagesByPeer: {
      acct_support_owner: [
        cloudMessage({ messageId: 'msg-user-request', body: requestBody }),
        cloudMessage({
          messageId: 'msg-support-response',
          fromAccountId: 'acct_support_owner',
          toAccountId: 'acct_user',
          direction: 'incoming',
          body: encodeCloudAgentResponse({ requestId: 'msg-user-request', text: 'Hi! How can I help?' }),
          createdAt: '2026-06-26T23:10:01Z',
          deliveredAt: '2026-06-26T23:10:01Z',
        }),
      ],
    },
  });

  assert.deepEqual(state.conversations.map((conversation) => conversation.id), ['bridge:cloud:acct_support_owner']);
  assert.equal(state.conversations[0]?.peerRuntime, 'kordi-desktop');
  assert.equal(state.conversations[0]?.title, 'Kordi Support');
  assert.deepEqual(state.conversations[0]?.messages.map((message) => message.text), ['hihi', 'Hi! How can I help?']);
});

test('support contact send body is encoded for the configured hosted support agent', () => {
  const body = cloudBridgeSendBodyForConversation({
    conversationId: 'bridge:cloud:acct_support_owner',
    text: 'I have a suggestion',
    contacts: [supportContactFixture()],
  });

  const parsed = parseCloudDirectMessageEnvelope(body);
  assert.equal(parsed?.text, 'I have a suggestion');
  assert.equal(parsed?.targetCloudAgentId, 'cloud_agent_kordi_support');
  assert.equal(parsed?.targetCloudAgentOwnerAccountId, 'acct_support_owner');
});
