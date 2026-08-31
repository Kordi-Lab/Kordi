import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolvePreferredAgentMentionTarget } from '../src/features/chat/messageActions/cloudAgentMentionTarget';
import { resolveMentionedLocalAgentTarget } from '../src/features/chat/messageActions/mentions';
import type { DesktopCollaborationState, DesktopChatState } from '../src/kordi-app/types';

test('renamed local agent mentions resolve to the immutable default Cloud agent id', async () => {
  const state = {
    activeHostId: 'host-1',
    hosts: [{
      id: 'host-1', endpoint: 'cloud', nodeId: 'host-node-1', humanId: 'host-human-1', ownerName: 'Host Owner',
      activeAgentId: 'local-agent', agents: [{ id: 'local-agent', label: 'BabyTREE', nodeId: 'host-node-1', runtime: 'kordi-local' }],
      visiblePeers: [{
        endpoint: 'cloud', nodeId: 'acct-peer', displayName: 'Kordi', ownerName: 'Peer', runtime: 'kordi-cloud-agent',
        humanId: 'acct-peer', agentId: 'cloud-agent:acct-peer', isDefaultAgent: true, isContact: true, contactRequestStatus: 'approved', sharedProjects: [],
      }],
    }],
  } as DesktopCollaborationState;
  const target = resolveMentionedLocalAgentTarget('@BabyTREE this is just a test', {
    localAgent: { label: 'BabyTREE' },
  } as DesktopChatState, state);

  assert.equal(target?.displayLabel, 'BabyTREE');
  assert.equal(target?.peer.humanId, 'host-human-1');
  assert.equal(target?.peer.agentId, 'cloud-agent:host-human-1');
  assert.equal(target?.requestText, 'this is just a test');

  const directPerson = {
    id: 'bridge:cloud:acct-peer:person', canonicalSessionId: 'session:direct-person:host-human-1:acct-peer',
    directness: 'Direct person chat', collaborationTarget: { hostId: 'host-1', nodeId: 'acct-peer', humanId: 'acct-peer', runtime: 'person' },
    canonicalParticipants: [{ id: 'human:acct-peer', name: 'Peer', kind: 'human', role: 'person', humanId: 'acct-peer', sourceIdentityId: 'acct-peer' }],
  };
  const remote = await resolvePreferredAgentMentionTarget('@Kordi hi', { localAgent: { label: 'BabyTREE' } } as DesktopChatState, state, directPerson, [], undefined, false, true);
  const local = await resolvePreferredAgentMentionTarget('@BabyTREE hi', { localAgent: { label: 'BabyTREE' } } as DesktopChatState, state, directPerson, [], undefined, false, true);
  assert.equal(remote?.peer.humanId, 'acct-peer');
  assert.equal(local?.peer.humanId, 'host-human-1');
});
