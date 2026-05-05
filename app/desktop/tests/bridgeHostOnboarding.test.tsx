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
  const agentsIndex = markup.indexOf('Agent reachability');

  assert.ok(visibilityIndex >= 0, 'visibility step renders');
  assert.ok(detailIndex > visibilityIndex, 'active detail expands after its step label');
  assert.ok(agentsIndex > detailIndex, 'next step stays below the expanded active detail');
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

test('Bridge onboarding omits the approvals step from this page', () => {
  const markup = renderDetails('visibility');

  assert.doesNotMatch(markup, /Approvals/);
  assert.doesNotMatch(markup, /Open approvals/);
  assert.doesNotMatch(markup, /Pending approvals/);
});

test('Bridge legacy approvals active step falls through to agent reachability', () => {
  const markup = renderDetails('approvals');

  assert.match(markup, /Agent reachability/);
  assert.match(markup, /Everyone on server/);
  assert.doesNotMatch(markup, /Pending approvals/);
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

  const agentsMarkup = renderDetails('agents', { activeBridgePeople, activeBridgeAgents });
  assert.doesNotMatch(agentsMarkup, /Visible people/);
  assert.doesNotMatch(agentsMarkup, /Visible agents/);

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
