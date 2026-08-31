import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveMentionedLocalAgentTarget } from '../src/features/chat/messageActions/mentions';
import type { DesktopCollaborationState, DesktopChatState } from '../src/kordi-app/types';

test('renamed local agent mentions resolve to the immutable default Cloud agent id', () => {
  const state = {
    activeHostId: 'host-1',
    hosts: [{
      id: 'host-1', endpoint: 'cloud', nodeId: 'host-node-1', humanId: 'host-human-1', ownerName: 'Host Owner',
      activeAgentId: 'local-agent', agents: [{ id: 'local-agent', label: 'BabyTREE', nodeId: 'host-node-1', runtime: 'kordi-local' }],
      visiblePeers: [],
    }],
  } as DesktopCollaborationState;
  const target = resolveMentionedLocalAgentTarget('@BabyTREE this is just a test', {
    localAgent: { label: 'BabyTREE' },
  } as DesktopChatState, state);

  assert.equal(target?.displayLabel, 'BabyTREE');
  assert.equal(target?.peer.humanId, 'host-human-1');
  assert.equal(target?.peer.agentId, 'cloud-agent:host-human-1');
  assert.equal(target?.requestText, 'this is just a test');
});
