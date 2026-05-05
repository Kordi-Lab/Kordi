import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import assert from 'node:assert/strict';
import test from 'node:test';

import { BridgeDetailsSection } from '../src/pages/bridge/BridgeDetailsSection';
import type { BridgeDetailsSectionProps, BridgeStepId } from '../src/pages/bridge/BridgeConfigPage.types';
import type { DesktopBridgeHost } from '../src/kordi-app/types';

function host(overrides: Partial<DesktopBridgeHost> = {}): DesktopBridgeHost {
  return {
    id: 'host-1',
    registered: true,
    connected: true,
    serverUrl: 'http://127.0.0.1:17080',
    nodeId: 'kd_self',
    displayName: "Shuyang's Kordi",
    ownerName: 'Shuyang',
    endpoint: 'http://127.0.0.1:17080/kd_self',
    tokenPresent: true,
    humanId: 'kh_self',
    discoveryMode: 'open',
    humanVisibilityPolicy: 'server-approval',
    contactApprovalPolicy: 'approval-required',
    activeAgentId: 'agent-1',
    agents: [{
      id: 'agent-1',
      label: "Shuyang's Kordi",
      nodeId: 'kd_agent',
      runtime: 'kordi-desktop',
      isDefault: true,
      isActive: true,
      registered: true,
      reachabilityPolicy: 'contacts',
    }],
    visiblePeers: [],
    visiblePeerCount: 0,
    projects: [],
    contactRequests: [],
    lastError: null,
    ...overrides,
  };
}

function renderDetails(activeStep: BridgeStepId, overrides: Partial<BridgeDetailsSectionProps> = {}) {
  const baseHost = host(overrides.activeBridgeHost ? {} : undefined);
  const props: BridgeDetailsSectionProps = {
    activeBridgeHost: baseHost,
    activeBridgePeople: [],
    activeBridgeAgents: [],
    bridgeSettingsDraft: {
      hostId: 'host-1',
      serverUrl: baseHost.serverUrl,
      displayName: baseHost.displayName,
      ownerName: baseHost.ownerName,
    },
    setBridgeSettingsDraft: () => {},
    isDesktopBridgeSaving: false,
    onSaveBridgeSettings: () => {},
    onCopyBridgeText: () => {},
    onSetBridgeDiscoveryMode: async () => {},
    onSetBridgeHostPrivacyPolicy: async () => {},
    onSetBridgeAgentReachabilityPolicy: async () => {},
    onApproveBridgeContactRequest: async () => {},
    onRejectBridgeContactRequest: async () => {},
    onCreateBridgeAgent: async () => {},
    onActivateBridgeAgent: async () => {},
    onSetDefaultBridgeAgent: async () => {},
    onAddBridgeContact: async () => {},
    onRemoveBridgeContact: async () => {},
    onOpenBridgeConversation: () => {},
    activeStep,
    setActiveStep: () => {},
    setActiveSection: () => {},
    contactNodeId: '',
    setContactNodeId: () => {},
    identityOwnerName: baseHost.ownerName,
    setIdentityOwnerName: () => {},
    ...overrides,
  };
  return renderToStaticMarkup(createElement(BridgeDetailsSection, props));
}

test('Bridge details renders an expandable host onboarding timeline', () => {
  const markup = renderDetails('visibility');

  assert.match(markup, /app-bridge-timeline/);
  assert.match(markup, /How you appear/);
  assert.match(markup, /Visibility/);
  assert.match(markup, /Approvals/);
  assert.match(markup, /Agent reachability/);
  assert.match(markup, /Review/);
});

test('Bridge visibility step exposes privacy and contact approval policies', () => {
  const markup = renderDetails('visibility');

  assert.match(markup, /Discovery visibility and private protection/);
  assert.match(markup, /Visible \+ reachable/);
  assert.match(markup, /Require approval/);
  assert.match(markup, /Private/);
});

test('Bridge approvals step shows incoming requests before direct reachability is granted', () => {
  const activeBridgeHost = host({
    contactRequests: [{
      requestId: 'req-1',
      requesterNodeId: 'kd_peer',
      targetNodeId: 'kd_self',
      status: 'pending',
      message: 'Please add me',
      createdAt: '2026-05-05T00:00:00Z',
      direction: 'incoming',
    }],
  });
  const markup = renderDetails('approvals', { activeBridgeHost });

  assert.match(markup, /Pending approvals/);
  assert.match(markup, /Incoming request/);
  assert.match(markup, /kd_peer/);
  assert.match(markup, /Approve/);
  assert.match(markup, /Reject/);
});

test('Bridge agents step renders per-agent reachability controls', () => {
  const markup = renderDetails('agents');

  assert.match(markup, /Agent reachability/);
  assert.match(markup, /Everyone on server/);
  assert.match(markup, /Contacts only/);
  assert.match(markup, /Only me/);
});
