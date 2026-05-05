import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ACCEPTED_CONTACT_AUTO_MESSAGE,
  bridgeContactApprovalGreetingTarget,
} from '../src/features/bridge/useBridgeOrchestration';
import type { DesktopBridgeHost } from '../src/kordi-app/types';

function host(overrides: Partial<DesktopBridgeHost> = {}): DesktopBridgeHost {
  return {
    id: 'host-1',
    registered: true,
    connected: true,
    serverUrl: 'http://127.0.0.1:17080',
    nodeId: 'kd_me',
    displayName: 'My Kordi',
    ownerName: 'Me',
    endpoint: '',
    tokenPresent: true,
    humanId: 'kh_me',
    discoveryMode: 'open',
    agents: [],
    visiblePeers: [{
      nodeId: 'kd_requester',
      displayName: 'Requester Kordi',
      ownerName: 'Requester',
      runtime: 'person',
      endpoint: '',
      sharedProjects: [],
      humanId: 'kh_requester',
      isContact: false,
    }],
    visiblePeerCount: 1,
    projects: [],
    contactRequests: [{
      requestId: 'req-1',
      requesterNodeId: 'kd_requester',
      targetNodeId: 'kd_me',
      status: 'pending',
      message: null,
      createdAt: '2026-05-05T00:00:00Z',
      direction: 'incoming',
    }],
    ...overrides,
  };
}

test('bridgeContactApprovalGreetingTarget resolves requester for pending incoming approvals', () => {
  assert.equal(ACCEPTED_CONTACT_AUTO_MESSAGE, "i accept your request, let's chat");
  assert.deepEqual(bridgeContactApprovalGreetingTarget(host(), 'req-1'), {
    hostId: 'host-1',
    peerNodeId: 'kd_requester',
    peerDisplayName: 'Requester Kordi',
    peerOwnerName: 'Requester',
    peerRuntime: 'person',
  });
});

test('bridgeContactApprovalGreetingTarget ignores outgoing or already decided requests', () => {
  assert.equal(bridgeContactApprovalGreetingTarget(host({
    contactRequests: [{
      requestId: 'req-1',
      requesterNodeId: 'kd_me',
      targetNodeId: 'kd_other',
      status: 'pending',
      message: null,
      createdAt: '2026-05-05T00:00:00Z',
      direction: 'outgoing',
    }],
  }), 'req-1'), null);

  assert.equal(bridgeContactApprovalGreetingTarget(host({
    contactRequests: [{
      requestId: 'req-1',
      requesterNodeId: 'kd_requester',
      targetNodeId: 'kd_me',
      status: 'approved',
      message: null,
      createdAt: '2026-05-05T00:00:00Z',
      decidedAt: '2026-05-05T00:01:00Z',
      direction: 'incoming',
    }],
  }), 'req-1'), null);
});
