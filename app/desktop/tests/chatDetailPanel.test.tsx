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


test('chat detail task panel renders delegated task in the existing task row style', () => {
  const markup = renderToStaticMarkup(createElement(ChatDetailPanel, {
    isNativeShell: true,
    activeDetailTab: 'tasks',
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
      participants: ['Me', 'Alice', 'Remote Kordi'],
      messages: [],
      taskActivities: [{
        id: 'delegation:1',
        sessionId: 'session:group:weekend-plan',
        status: 'processing',
        initiator: { id: 'human:me', name: 'Me', kind: 'human', role: 'self', avatarKey: 'me' },
        target: { id: 'agent:remote', name: 'Remote Kordi', kind: 'agent', role: 'external-agent', avatarKey: 'remote-agent' },
        participants: [
          { id: 'human:me', name: 'Me', kind: 'human', role: 'self', avatarKey: 'me' },
          { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', avatarKey: 'alice' },
          { id: 'agent:remote', name: 'Remote Kordi', kind: 'agent', role: 'external-agent', avatarKey: 'remote-agent' },
        ],
        createdAtMs: 1,
        updatedAtMs: 2,
        bridgeConversationId: 'bridge:host:remote-agent',
        bridgeRequestId: 'bridge_req_task',
        contextPolicy: 'session-message',
      }],
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
  }));

  assert.match(markup, /Remote Kordi/);
  assert.match(markup, /Delegated by Me/);
  assert.match(markup, /Shared with 3 participants/);
  assert.match(markup, /Running/);
  assert.doesNotMatch(markup, /Research Agent relay/);
});

test('chat detail task panel renders empty task state', () => {
  const markup = renderToStaticMarkup(createElement(ChatDetailPanel, {
    isNativeShell: true,
    activeDetailTab: 'tasks',
    activeConv: {
      id: 'session:group:empty',
      canonicalSessionId: 'session:group:empty',
      name: 'Empty group',
      type: 'person',
      subtitle: '',
      unread: 0,
      bridges: ['Bridge'],
      trust: 'Bridge',
      directness: 'Group chat',
      participants: ['Me'],
      messages: [],
      taskActivities: [],
    },
    activeConvHasSubtitle: false,
    activeLastMessage: undefined,
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
  }));

  assert.match(markup, /No delegated tasks in this session yet/);
});
