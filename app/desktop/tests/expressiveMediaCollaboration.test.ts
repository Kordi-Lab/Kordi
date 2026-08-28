import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalAttachments } from '../src/features/canonical/readModel/messageMapping';
import { cacheCloudAttachmentLocalPath, clearCloudAttachmentLocalPathCache } from '../src/features/cloud/cloudAttachmentLocalPathCache';
import { mapCollaborationConversationToViewModel } from '../src/features/collaboration/transcript';
import type { DesktopCollaborationConversation, DesktopCollaborationHost } from '../src/kordi-app/types';

const host: DesktopCollaborationHost = {
  id: 'host-1', registered: true, connected: true, serverUrl: 'https://bridge.test',
  nodeId: 'node-me', displayName: 'My Kordi', ownerName: 'Me', endpoint: 'https://bridge.test',
  tokenPresent: true, humanId: 'human-me', discoveryMode: 'ask', activeAgentId: null,
  agents: [], visiblePeers: [], visiblePeerCount: 0, projects: [],
};

const conversation: DesktopCollaborationConversation = {
  id: 'bridge:host-1:node-peer:person', canonicalSessionId: 'session:bridge:humans:peer',
  hostId: 'host-1', peerNodeId: 'node-peer', peerDisplayName: 'Ethan', peerOwnerName: 'Ethan',
  peerRuntime: 'person', projectId: null, projectName: null, title: 'Ethan', subtitle: 'hi',
  unreadCount: 0, updatedAtMs: 1, updatedAtLabel: '16:39', awaitingReply: false,
  peerTyping: false, peerLastHeartbeatLabel: null, outreach: null, identity: null,
  messages: [{
    id: 'server-message-id', clientMessageId: '77777777-7777-4777-8777-777777777777',
    direction: 'outbound', sender: 'Me', text: '', timeLabel: '09:57', timestampMs: 2,
  }],
};

test('collaboration transcript retains the optimistic client message identity', () => {
  const view = mapCollaborationConversationToViewModel(conversation, host, 'My Kordi');
  assert.equal(view.messages[0]?.clientMessageId, '77777777-7777-4777-8777-777777777777');
});

test('synced attachments inherit the hot upload cache without changing layout', () => {
  clearCloudAttachmentLocalPathCache();
  cacheCloudAttachmentLocalPath('att_completed', '/cache/completed.png');
  try {
    assert.equal(canonicalAttachments([{
      attachmentId: 'att_completed', kind: 'image', name: 'completed.png',
    }])?.[0]?.localPath, '/cache/completed.png');
  } finally {
    clearCloudAttachmentLocalPathCache();
  }
});
