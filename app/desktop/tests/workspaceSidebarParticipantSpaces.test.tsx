import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { buildParticipantSpaces } from '../src/features/chat/participantSpaces';
import type { Conversation } from '../src/kordi-app/types';
import { WorkspaceSidebar } from '../src/pages/WorkspaceSidebar';

type ConversationFixture = Conversation & { _updatedAtMs?: number };

function conversation(overrides: Partial<ConversationFixture> = {}): ConversationFixture {
  return {
    id: 'session:bob:old',
    canonicalSessionId: 'session:bob:old',
    name: 'Old Bob thread',
    type: 'person',
    subtitle: 'Old preview',
    unread: 1,
    bridges: ['Bridge'],
    trust: 'Bridge',
    directness: 'Direct chat',
    participants: ['Me', 'Bob'],
    canonicalParticipants: [
      { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
      { id: 'human:bob', name: 'Bob', kind: 'human', role: 'delegate', source: 'bridge', avatarKey: 'bob' },
    ],
    messages: [{ role: 'person', sender: 'Bob', text: 'Old preview', time: '09:00' }],
    updatedAtLabel: '09:00',
    _updatedAtMs: 1,
    ...overrides,
  };
}

function baseSidebarProps(overrides: Record<string, unknown> = {}) {
  const chatConversations = [
    conversation(),
    conversation({
      id: 'session:bob:new',
      canonicalSessionId: 'session:bob:new',
      name: 'New Bob thread',
      subtitle: 'New preview',
      unread: 2,
      messages: [{ role: 'person', sender: 'Bob', text: 'New preview', time: '10:00' }],
      updatedAtLabel: '10:00',
      _updatedAtMs: 2,
    }),
  ];
  const participantSpaces = buildParticipantSpaces(chatConversations);

  return {
    isNativeShell: false,
    isSingleWorkspacePage: false,
    collapseChatSessions: false,
    showSessionRail: true,
    sessionRailWidth: 248,
    activeNav: 'chats',
    setActiveNav: () => {},
    chatConversations,
    participantSpaces,
    onCreateChatSession: () => {},
    chatSearch: '',
    setChatSearch: () => {},
    chatFilter: 'all',
    setChatFilter: () => {},
    isDesktopChatLoading: false,
    desktopChatError: null,
    filteredConversations: chatConversations,
    filteredParticipantSpaces: participantSpaces,
    activeConvId: 'session:bob:new',
    onSelectChatSession: () => {},
    onArchiveChatSession: () => {},
    onDeleteChatSession: () => {},
    onMoveChatSessionToProject: () => {},
    onCreateProjectFromFolder: () => {},
    onCreateProject: () => {},
    runtimeProjects: [],
    projectSearch: '',
    setProjectSearch: () => {},
    filteredProjects: [],
    activeProjectId: '',
    activeProjectSessionId: '',
    projectSelectedSessionIds: {},
    selectProject: () => {},
    expandedProjectIds: {},
    setExpandedProjectIds: () => {},
    onSelectProjectSession: () => {},
    groupedContacts: [],
    displayedContacts: [],
    setActiveContactGroup: () => {},
    setActiveContactId: () => {},
    displayedAgents: [],
    activeBridgeHost: null,
    localProfileAvatarSeed: 'me',
    onRefreshBridge: () => {},
    onCopyBridgeHostUrl: () => {},
    onCreateBridgeDraft: () => {},
    ...overrides,
  };
}

test('WorkspaceSidebar renders participant spaces as the Chats first level', () => {
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps() as never));

  assert.match(markup, /data-chat-sidebar-mode="participant-spaces"/);
  assert.match(markup, /Bob/);
  assert.match(markup, /2 sessions/);
  assert.match(markup, /New preview/);
  assert.doesNotMatch(markup, /Old Bob thread/);
  assert.doesNotMatch(markup, /New Bob thread/);
});

test('WorkspaceSidebar labels human-centered and self spaces clearly', () => {
  const chatConversations = [
    conversation({
      id: 'session:shu-agent',
      canonicalSessionId: 'session:shu-agent',
      name: 'Agent-assisted chat with shu',
      subtitle: "shuhere2's Kordi joined via mention",
      participants: ['Me', 'shu', "shuhere2's Kordi"],
      _updatedAtMs: 3,
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:shu', name: 'shu', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'shu' },
        { id: 'agent:shuhere2-kordi', name: "shuhere2's Kordi", kind: 'agent', role: 'delegate', source: 'bridge', avatarKey: 'agent-shu' },
      ],
    }),
    conversation({
      id: 'session:my-kordi',
      canonicalSessionId: 'session:my-kordi',
      name: 'Planning with My Kordi',
      type: 'owned-agent',
      subtitle: 'Sketch the plan',
      participants: ['Me', 'My Kordi'],
      _updatedAtMs: 2,
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'agent:my-kordi', name: 'My Kordi', kind: 'agent', role: 'delegate', source: 'local', avatarKey: 'my-kordi' },
      ],
    }),
    conversation({
      id: 'session:remote-agent',
      canonicalSessionId: 'session:remote-agent',
      name: 'Ask Research Kordi',
      type: 'external-agent',
      subtitle: 'Find references',
      participants: ['Me', 'Research Kordi'],
      _updatedAtMs: 1,
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'agent:research-kordi', name: 'Research Kordi', kind: 'agent', role: 'delegate', source: 'bridge', avatarKey: 'research-kordi' },
      ],
    }),
  ];
  const participantSpaces = buildParticipantSpaces(chatConversations);
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations,
    participantSpaces,
    filteredParticipantSpaces: participantSpaces,
    activeConvId: 'session:shu-agent',
  }) as never));

  assert.match(markup, /shu/);
  assert.match(markup, /Person \+ 1 agent • 1 session/);
  assert.match(markup, /Myself/);
  assert.match(markup, /Myself \+ 2 agents • 2 sessions/);
  assert.doesNotMatch(markup, /Group • 1 session/);
});
