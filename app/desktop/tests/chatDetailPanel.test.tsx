import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ChatDetailPanel } from '../src/pages/ChatDetailPanel';

test('chat detail panel keeps outreach threads out of the normal info view', () => {
  const markup = renderToStaticMarkup(createElement(ChatDetailPanel, {
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
      trust: 'Bridge',
      directness: 'Group chat',
      participants: ['Me', 'Testuser5', 'Testuser4'],
      outreachThreads: [{
        id: 'desktop-bridge-outreach:thread-1',
        title: 'Testuser5',
        targetDisplayName: 'Testuser5',
        targetKind: 'bridge-person',
        subtitle: 'Internal outreach copy',
        status: 'completed',
        updatedAtLabel: '13:58',
      }],
      messages: [],
    },
    activeConvHasSubtitle: true,
    activeLastMessage: { time: '13:58', text: 'Latest update' },
    activeConversationIsBridge: false,
    activeBridgeConversationHostNodeId: null,
    activeBridgeConversationHostUrl: null,
    activeBridgeConversation: null,
    activeBridgeAwaitingReply: false,
    isBridgePolling: false,
    lastBridgePollAtLabel: null,
    activeSessionProject: null,
    artifacts: [],
    activeArtifactId: null,
    onSelectArtifact: () => {},
    onOpenOutreachThread: () => {},
  }));

  assert.match(markup, /Weekend plan/);
  assert.doesNotMatch(markup, /Outreach threads/);
  assert.doesNotMatch(markup, /Internal outreach copy/);
});
