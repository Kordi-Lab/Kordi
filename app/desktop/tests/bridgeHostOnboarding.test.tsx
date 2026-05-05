import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import assert from 'node:assert/strict';
import test from 'node:test';

import { BridgeDetailsSection } from '../src/pages/bridge/BridgeDetailsSection';
import type { BridgeDetailsSectionProps, BridgeStepId } from '../src/pages/bridge/BridgeConfigPage.types';
import type { DesktopBridgeHost, DesktopBridgePeer } from '../src/kordi-app/types';

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

test('Bridge details renders step details inline between timeline steps', () => {
  const markup = renderDetails('visibility');

  assert.match(markup, /app-bridge-timeline/);
  assert.match(markup, /app-bridge-step-detail-region/);
  const visibilityIndex = markup.indexOf('Visibility');
  const detailIndex = markup.indexOf('Discovery visibility and private protection');
  const approvalsIndex = markup.indexOf('Approvals');

  assert.ok(visibilityIndex >= 0, 'visibility step renders');
  assert.ok(detailIndex > visibilityIndex, 'active detail expands after its step label');
  assert.ok(approvalsIndex > detailIndex, 'next step stays below the expanded active detail');
});

test('Bridge visibility step exposes one coherent privacy mode list', () => {
  const markup = renderDetails('visibility');

  assert.match(markup, /Discovery visibility and private protection/);
  assert.match(markup, /app-bridge-privacy-mode-list/);
  assert.match(markup, /Private \/ invite only/);
  assert.match(markup, /Listed, approve new people/);
  assert.match(markup, /Open on this host/);
  assert.match(markup, /saved when you continue/i);
  assert.doesNotMatch(markup, /Human \/ host visibility/);
  assert.doesNotMatch(markup, /Current policy:.*Require approval/);
});

test('Bridge visibility step normalizes conflicting privacy settings to the approval mode', () => {
  const markup = renderDetails('visibility', {
    activeBridgeHost: host({
      humanVisibilityPolicy: 'server-open',
      contactApprovalPolicy: 'approval-required',
    }),
  });

  assert.match(markup, /Listed, approve new people selected/);
  assert.match(markup, /Saved on this host/);
});

test('Bridge review step includes a final save action with feedback', () => {
  const markup = renderDetails('review');

  assert.match(markup, /Save and finish/);
  assert.match(markup, /app-bridge-review-save-status/);
  assert.match(markup, /aria-live="polite"/);
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

test('Bridge approvals step removes direct node-id add actions from setup', () => {
  const markup = renderDetails('approvals');

  assert.match(markup, /Pending approvals/);
  assert.doesNotMatch(markup, /Add someone by node ID/);
  assert.doesNotMatch(markup, /Add \+ chat/);
  assert.doesNotMatch(markup, /kd_\.\.\./);
});

test('Bridge visible peer lists are deferred until the review step', () => {
  const activeBridgePeople: DesktopBridgePeer[] = [{
    nodeId: 'kd_person',
    displayName: 'Ada Bridge',
    runtime: 'kordi-desktop',
    endpoint: 'http://127.0.0.1:17080/kd_person',
    ownerName: 'Ada',
    sharedProjects: [],
    humanId: 'kh_ada',
    agentId: null,
  }];
  const activeBridgeAgents: DesktopBridgePeer[] = [{
    nodeId: 'kd_agent_peer',
    displayName: 'Calc Agent',
    runtime: 'kordi-desktop',
    endpoint: 'http://127.0.0.1:17080/kd_agent_peer',
    ownerName: 'Ada',
    sharedProjects: [],
    humanId: 'kh_ada',
    agentId: 'ka_calc',
    isDefaultAgent: true,
  }];

  const approvalsMarkup = renderDetails('approvals', { activeBridgePeople, activeBridgeAgents });
  assert.doesNotMatch(approvalsMarkup, /Visible people/);
  assert.doesNotMatch(approvalsMarkup, /Visible agents/);

  const reviewMarkup = renderDetails('review', { activeBridgePeople, activeBridgeAgents });
  assert.match(reviewMarkup, /Visible people/);
  assert.match(reviewMarkup, /Ada Bridge/);
  assert.match(reviewMarkup, /Visible agents/);
  assert.match(reviewMarkup, /Calc Agent/);
});

test('Bridge agents step renders per-agent reachability controls', () => {
  const markup = renderDetails('agents');

  assert.match(markup, /Agent reachability/);
  assert.match(markup, /Everyone on server/);
  assert.match(markup, /Contacts only/);
  assert.match(markup, /Only me/);
});
