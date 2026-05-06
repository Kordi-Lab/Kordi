import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ChatDetailPanel } from '../src/pages/ChatDetailPanel';

const baseOutreach = {
  targetKind: 'bridge-person',
  parentSessionId: 'session:group:88bbd974-b87f-4e04-a9dc-40c4c9bf1af7',
  bridgeHostId: 'bridge-host-1',
  bridgeRequestId: 'bridge-request-1',
  targetNodeId: 'kd_remote',
  targetHumanId: 'human-remote',
  targetDisplayName: 'Kordi User 3',
  targetOwnerName: 'Kordi User 3',
  requestText: 'NLP/AI conference deadlines',
  contextPolicy: 'session-message',
  status: 'complete',
  createdAtMs: 1_000,
  updatedAtMs: 2_000,
};

function renderInfoPanel(overrides = {}) {
  return renderToStaticMarkup(createElement(ChatDetailPanel, {
    isNativeShell: true,
    activeDetailTab: 'info',
    activeConv: {
      id: 'session:group:weekend-plan',
      canonicalSessionId: 'session:group:weekend-plan',
      name: 'Weekend plan',
      type: 'person',
      subtitle: 'session:group:weekend-plan',
      unread: 0,
      bridges: ['Bridge'],
      trust: 'Owned',
      directness: 'Group chat',
      participants: ['Me', 'Testuser5', 'Testuser4'],
      messages: [],
      ...overrides,
    },
    activeConvHasSubtitle: true,
    activeLastMessage: { time: '13:58', text: 'Latest update' },
    activeConversationIsBridge: true,
    activeBridgeConversationHostNodeId: 'kd_local',
    activeBridgeConversationHostUrl: 'https://bridge.example.test',
    activeBridgeConversation: {
      peerNodeId: 'kd_remote',
      peerRuntime: 'desktop',
      projectName: null,
      projectId: null,
      title: 'Weekend plan',
      peerTyping: false,
    },
    activeBridgeAwaitingReply: false,
    isBridgePolling: false,
    lastBridgePollAtLabel: null,
    activeSessionProject: null,
    artifacts: [],
    activeArtifactId: null,
    onSelectArtifact: () => {},
    onOpenOutreachThread: () => {},
  }));
}

test('chat detail panel keeps outreach threads out of the normal info view', () => {
  const markup = renderInfoPanel({
    outreachThreads: [{
      id: 'desktop-bridge-outreach:thread-1',
      title: 'Testuser5',
      targetDisplayName: 'Testuser5',
      targetKind: 'bridge-person',
      subtitle: 'Internal outreach copy',
      status: 'completed',
      updatedAtLabel: '13:58',
    }],
  });

  assert.match(markup, /Weekend plan/);
  assert.doesNotMatch(markup, /Outreach threads/);
  assert.doesNotMatch(markup, /Internal outreach copy/);
});

test('chat detail panel hides outreach, trust, and mode metadata in Bridge chat info', () => {
  const markup = renderInfoPanel({
    outreach: baseOutreach,
    identity: {
      bridgeHostId: 'bridge-host-1',
      localHumanId: 'human-local',
      localHumanName: 'Kordi User 1',
      localAgentId: 'agent-local',
      localAgentName: "Kordi User 1's Kordi",
      remoteHumanId: 'human-remote',
      remoteHumanName: 'Kordi User 3',
      remoteAgentName: null,
    },
  });

  assert.match(markup, /Weekend plan/);
  assert.doesNotMatch(markup, /Outreach status/);
  assert.doesNotMatch(markup, /<div class="app-detail-kicker">Outreach<\/div>/);
  assert.doesNotMatch(markup, /Person outreach/);
  assert.doesNotMatch(markup, /NLP\/AI conference deadlines/);
  assert.doesNotMatch(markup, /Source chat ID/);
  assert.doesNotMatch(markup, /Local human/);
  assert.doesNotMatch(markup, /Remote human/);
  assert.doesNotMatch(markup, /Trust/);
  assert.doesNotMatch(markup, /Owned/);
  assert.doesNotMatch(markup, /Mode/);
  assert.doesNotMatch(markup, /Group chat/);
});

test('chat detail panel never shows explicit outreach metadata in the normal info view', () => {
  const markup = renderInfoPanel({
    type: 'external-agent',
    directness: 'Agent outreach',
    outreach: {
      ...baseOutreach,
      targetKind: 'bridge-agent',
      targetAgentId: 'agent-remote',
      targetDisplayName: "Kordi User 3's Kordi",
      requestText: 'Summarize this thread',
      triggerText: "@Kordi User 3's Kordi Summarize this thread",
      contextPolicy: 'recent-window',
      status: 'awaitingReply',
    },
  });

  assert.match(markup, /Weekend plan/);
  assert.doesNotMatch(markup, /Outreach status/);
  assert.doesNotMatch(markup, /<div class="app-detail-kicker">Outreach<\/div>/);
  assert.doesNotMatch(markup, /Agent outreach/);
  assert.doesNotMatch(markup, /Summarize this thread/);
  assert.doesNotMatch(markup, /Kordi User 3&#x27;s Kordi/);
});
