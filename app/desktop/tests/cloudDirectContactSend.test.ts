import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { shouldAppendOptimisticBridgeMessage } from '../src/features/chat/messageActions/chatMessages';
import { appendOptimisticBridgeMessage } from '../src/features/chat/messageActions/optimistic';
import { cloudSessionIdForBridgeSend, mergeCloudBridgeOverrideState } from '../src/features/cloud/cloudBridgeState';
import type { DesktopBridgeState } from '../src/kordi-app/types';

test('direct Cloud contact sends use an optimistic row so attachments preview immediately', () => {
  assert.equal(shouldAppendOptimisticBridgeMessage('bridge:cloud:acct_peer:person'), true);
  assert.equal(shouldAppendOptimisticBridgeMessage('bridge:local:node_peer:person'), true);
});

test('direct Cloud support sends create an optimistic conversation before server sync returns', () => {
  const state: DesktopBridgeState = {
    configPath: '/tmp/config.json',
    legacyConfigPath: '/tmp/legacy.json',
    conversationsPath: '/tmp/conversations.sqlite3',
    activeHostId: 'cloud',
    hosts: [{
      id: 'cloud',
      registered: true,
      connected: true,
      serverUrl: 'kordi.cloud',
      nodeId: 'acct_me',
      displayName: 'Kordi Cloud',
      ownerName: 'Me',
      endpoint: 'kordi.cloud',
      tokenPresent: true,
      humanId: 'acct_me',
      discoveryMode: 'contacts',
      activeAgentId: null,
      agents: [],
      visiblePeerCount: 1,
      projects: [],
      visiblePeers: [{
        nodeId: 'acct_support_owner',
        displayName: 'Kordi Support',
        runtime: 'kordi-desktop',
        endpoint: 'kordi.cloud',
        ownerName: 'Kordi',
        createdAt: null,
        sharedProjects: [],
        humanId: 'acct_support_owner',
        agentId: 'cloud_agent_kordi_support',
        isDefaultAgent: true,
        discoveryMode: 'contacts',
        humanVisibilityPolicy: 'server-approval',
        contactApprovalPolicy: 'approval-required',
        agentReachabilityPolicy: 'contacts',
        isContact: true,
        contactRequestStatus: 'accepted',
        contactRequestDirection: 'outgoing',
        avatarSeed: 'cloud_agent_kordi_support',
      }],
    }],
    conversations: [],
    localServer: { running: false },
  };

  const next = appendOptimisticBridgeMessage(
    state,
    'bridge:cloud:acct_support_owner',
    'hihi',
    '23:33',
    'cloud-pending-1',
  );

  assert.equal(next?.conversations.length, 1);
  assert.equal(next?.conversations[0]?.id, 'bridge:cloud:acct_support_owner');
  assert.equal(next?.conversations[0]?.title, 'Kordi Support');
  assert.equal(next?.conversations[0]?.awaitingReply, true);
  assert.equal(next?.conversations[0]?.messages[0]?.text, 'hihi');
});

test('confirmed Cloud direct messages replace matching optimistic sending rows', () => {
  const generated: DesktopBridgeState = {
    configPath: 'cloud',
    legacyConfigPath: 'cloud',
    conversationsPath: 'cloud',
    activeHostId: 'cloud',
    hosts: [],
    localServer: { running: true },
    conversations: [{
      id: 'bridge:cloud:acct_support_owner',
      canonicalSessionId: 'bridge:cloud:acct_support_owner',
      hostId: 'cloud',
      peerNodeId: 'acct_support_owner',
      peerDisplayName: 'Kordi Support',
      peerOwnerName: 'Kordi',
      peerRuntime: 'kordi-desktop',
      title: 'Kordi Support',
      subtitle: 'hihi',
      unreadCount: 0,
      updatedAtMs: 2,
      updatedAtLabel: '00:28',
      awaitingReply: true,
      peerTyping: false,
      messages: [{
        id: 'msg-server-confirmed',
        direction: 'outbound',
        sender: 'Me',
        text: 'hihi',
        timeLabel: '00:28',
        timestampMs: 2,
        deliveryState: 'delivered',
        attachments: [],
      }],
    }],
  };
  const override = appendOptimisticBridgeMessage(
    { ...generated, conversations: [] },
    'bridge:cloud:acct_support_owner',
    'hihi',
    '00:28',
    'cloud-pending-1',
  );

  const merged = mergeCloudBridgeOverrideState(generated, override);

  assert.equal(merged.conversations[0]?.messages.length, 1);
  assert.equal(merged.conversations[0]?.messages[0]?.id, 'msg-server-confirmed');
  assert.equal(merged.conversations[0]?.messages[0]?.deliveryState, 'delivered');
});

test('direct Cloud sends keep optimistic bridge state until sync replaces it', () => {
  const source = readFileSync(new URL('../src/features/chat/messageActions/chatMessages.ts', import.meta.url), 'utf8');
  const branchStart = source.indexOf('if (activeConversationUsesBridgeRouting && isCloudBridgeConversationId(activeConvId))');
  const branchEnd = source.indexOf('if (activeConversationUsesBridgeRouting && shouldRouteMentionThroughCloudGroup', branchStart);
  assert.ok(branchStart >= 0 && branchEnd > branchStart, 'expected Cloud bridge send branch');
  const branch = source.slice(branchStart, branchEnd);
  assert.doesNotMatch(branch, /setCloudBridgeState\(null\)/);
});

test('direct Cloud contact sends include stable Cloud session id', () => {
  assert.equal(
    cloudSessionIdForBridgeSend('acct_me', 'acct_peer', 'bridge:cloud:acct_peer:person'),
    'session:direct-person:acct_me:acct_peer',
  );
  assert.equal(
    cloudSessionIdForBridgeSend('acct_peer', 'acct_me', 'bridge:cloud:acct_me:person'),
    'session:direct-person:acct_me:acct_peer',
  );
});
