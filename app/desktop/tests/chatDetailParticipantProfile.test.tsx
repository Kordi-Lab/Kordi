import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ChatDetailPanel } from '../src/pages/ChatDetailPanel';
import { ChatSenderProfileContext } from '../src/pages/useChatSenderProfiles';

test('chat detail participant avatars open profiles only for other people', () => {
  const panel = createElement(ChatDetailPanel, {
    isNativeShell: true,
    activeDetailTab: 'info',
    activeConv: {
      id: 'session:group:weekend-plan',
      canonicalSessionId: 'session:group:weekend-plan',
      name: 'Weekend plan',
      type: 'person',
      subtitle: 'session:group:weekend-plan',
      unread: 0,
      collaborationSources: ['Bridge'],
      trust: 'Owned',
      directness: 'Group chat',
      participants: ['Me', 'Maya', "Maya's Kordi"],
      canonicalParticipants: [
        { id: 'human:self', name: 'Me', kind: 'human', role: 'self' },
        { id: 'human:maya', name: 'Maya', kind: 'human', role: 'person' },
        { id: 'agent:maya', name: "Maya's Kordi", kind: 'agent', role: 'external-agent' },
      ],
      messages: [],
    },
    activeConvHasSubtitle: true,
    activeLastMessage: { time: '13:58', text: 'Latest update' },
    activeConversationUsesCollaboration: true,
    activeCollaborationConversationHostNodeId: 'kd_local',
    activeCollaborationConversationHostUrl: 'https://bridge.example.test',
    activeCollaborationConversation: {
      peerNodeId: 'kd_remote',
      peerRuntime: 'desktop',
      projectName: null,
      projectId: null,
      title: 'Weekend plan',
      peerTyping: false,
    },
    activeCollaborationAwaitingReply: false,
    isCollaborationSyncing: false,
    lastCollaborationSyncAtLabel: null,
    activeSessionProject: null,
    artifacts: [],
    activeArtifactId: null,
    onSelectArtifact: () => {},
    onOpenOutreachThread: () => {},
  });
  const markup = renderToStaticMarkup(createElement(
    ChatSenderProfileContext.Provider,
    { value: () => {} },
    panel,
  ));

  assert.equal(markup.match(/data-info-participant-profile="true"/g)?.length, 1);
  assert.match(markup, /aria-label="Open Maya profile"/);
  assert.doesNotMatch(markup, /aria-label="Open Me profile"/);
  assert.doesNotMatch(markup, /aria-label="Open Maya&#x27;s Kordi profile"/);
});
