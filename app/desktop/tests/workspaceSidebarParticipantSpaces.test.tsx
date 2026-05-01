import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { buildParticipantSpaces } from '../src/features/chat/participantSpaces';
import type { Agent, Contact, Conversation } from '../src/kordi-app/types';
import { ChatCreateDialog } from '../src/pages/ChatCreateDialog';
import { GroupDetailsDialog } from '../src/pages/GroupDetailsDialog';
import { participantSpaceSessionRowTitle, WorkspaceSidebar } from '../src/pages/WorkspaceSidebar';

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

function contact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 'contact:alice',
    name: 'Alice',
    initials: 'A',
    classType: 'other-users',
    entityType: 'Person',
    subtitle: 'Human contact',
    bridges: ['Bridge'],
    status: 'Online',
    discoverableOn: ['Bridge'],
    detail: 'Works on product',
    owner: 'Alice',
    avatarSeed: 'alice',
    profileImageUrl: null,
    ...overrides,
  };
}

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent:kordi',
    name: 'Kordi',
    role: 'Coding partner',
    messaging: 'Available',
    status: 'Ready',
    tasks: 0,
    defaultProvider: 'openai',
    defaultModel: 'gpt-5.2',
    bridgesConfig: 'Bridge',
    contactId: 'contact:kordi',
    systemPrompt: '',
    xMd: '',
    identityFiles: [],
    loadedTools: [],
    loadedSkills: [],
    loadedPlugins: [],
    lastActivities: [],
    avatarSeed: 'kordi',
    profileImageUrl: null,
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
    chatFilter: 'latest',
    setChatFilter: () => {},
    isDesktopChatLoading: false,
    desktopChatError: null,
    filteredConversations: chatConversations,
    filteredParticipantSpaces: participantSpaces,
    activeConvId: 'session:bob:new',
    onSelectChatSession: () => {},
    onStartChatWithPerson: () => {},
    onStartChatWithAgent: () => {},
    onCreateChatGroup: () => {},
    onCreateChatSessionInParticipantSpace: () => {},
    onRenameChatGroup: () => {},
    onAddChatGroupMembers: () => {},
    onRemoveChatGroupMember: () => {},
    onSetChatGroupAdmin: () => {},
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

test('WorkspaceSidebar renders participant spaces as first-page expandable rows with row actions', () => {
  const participantSpaces = buildParticipantSpaces(baseSidebarProps().chatConversations);
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    participantSpaces,
    filteredParticipantSpaces: participantSpaces,
    initialSelectedParticipantSpaceId: participantSpaces[0]?.id,
  }) as never));

  assert.match(markup, /data-chat-sidebar-mode="participant-spaces-inline"/);
  assert.match(markup, /Contacts/);
  assert.match(markup, /Groups/);
  assert.match(markup, /Latest/);
  assert.doesNotMatch(markup, />People</);
  assert.doesNotMatch(markup, />Agents</);
  assert.match(markup, /Bob/);
  assert.match(markup, /2 sessions/);
  assert.match(markup, /New preview/);
  assert.match(markup, /data-participant-space-toggle="true"/);
  assert.match(markup, /aria-label="Collapse Bob"/);
  assert.match(markup, /aria-label="Create session in Bob"/);
  assert.match(markup, /data-participant-space-context-create="true"/);
  assert.doesNotMatch(markup, /data-participant-space-enter="true"/);
  assert.doesNotMatch(markup, /Back to chats/);
  assert.match(markup, /Old Bob thread/);
  assert.match(markup, /New Bob thread/);
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
  assert.match(markup, /Person • 1 session/);
  assert.match(markup, /Notes to self/);
  assert.match(markup, /Personal • 2 sessions/);
  assert.doesNotMatch(markup, /Person \+ 1 agent/);
  assert.doesNotMatch(markup, /Myself \+ 2 agents/);
  assert.doesNotMatch(markup, /Group • 1 session/);
});

test('ChatCreateDialog renders compact theme-aware choices beside the plus button', () => {
  const markup = renderToStaticMarkup(createElement(ChatCreateDialog, {
    isOpen: true,
    contacts: [contact({ id: 'contact:alice', name: 'Alice' })],
    agents: [agent({ id: 'agent:kordi', name: 'Kordi' })],
    anchorRect: { left: 460, top: 40, width: 32, height: 32 },
    onClose: () => {},
    onStartPerson: () => {},
    onStartAgent: () => {},
    onCreateGroup: () => {},
  }));

  assert.match(markup, /data-create-surface="side-popover"/);
  assert.match(markup, /data-popover-placement="right"/);
  assert.match(markup, /app-chat-create-popover/);
  assert.match(markup, /app-frosted-popover/);
  assert.match(markup, /app-chat-create-popover-enter/);
  assert.doesNotMatch(markup, /bg-white\/80/);
  assert.doesNotMatch(markup, /text-slate-950/);
  assert.doesNotMatch(markup, /fixed inset-0 z-50 flex items-center justify-center/);
  assert.match(markup, /Chat with person/);
  assert.match(markup, /Chat with agent/);
  assert.match(markup, /Start group/);
});

test('ChatCreateDialog group picker requires at least 2 people and excludes agents', () => {
  const markup = renderToStaticMarkup(createElement(ChatCreateDialog, {
    isOpen: true,
    initialMode: 'group',
    contacts: [
      contact({ id: 'contact:alice', name: 'Alice', entityType: 'Person' }),
      contact({ id: 'contact:bob', name: 'Bob', entityType: 'Person' }),
      contact({ id: 'contact:agent', name: 'Helper Kordi', entityType: 'External agent', classType: 'other-users-agents' }),
    ],
    agents: [agent({ id: 'agent:kordi', name: 'Kordi' })],
    onClose: () => {},
    onStartPerson: () => {},
    onStartAgent: () => {},
    onCreateGroup: () => {},
  }));

  assert.match(markup, /Select at least 2 people/);
  assert.match(markup, /Alice/);
  assert.match(markup, /Bob/);
  assert.doesNotMatch(markup, /Helper Kordi/);
});

test('participant-space child session rows use hashtag titles', () => {
  assert.equal(participantSpaceSessionRowTitle('Hi shu'), '# Hi shu');
  assert.equal(participantSpaceSessionRowTitle('# Existing'), '# Existing');
});

test('GroupDetailsDialog renders group metadata and member controls', () => {
  const chatConversations = [conversation({
    id: 'session:group-details',
    canonicalSessionId: 'session:group-details',
    name: 'Design crew',
    participants: ['Me', 'Alice', 'Bob'],
    canonicalParticipants: [
      { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
      { id: 'human:alice', name: 'Alice', kind: 'human', role: 'admin', source: 'bridge', avatarKey: 'alice' },
      { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
    ],
  })];
  const [space] = buildParticipantSpaces(chatConversations);
  const markup = renderToStaticMarkup(createElement(GroupDetailsDialog, {
    isOpen: true,
    space,
    contacts: [contact({ id: 'contact:chen', name: 'Chen' })],
    onClose: () => {},
    onRename: () => {},
    onAddMembers: () => {},
    onRemoveMember: () => {},
    onSetAdmin: () => {},
  }));

  assert.match(markup, /data-group-management-surface="popover"/);
  assert.match(markup, /app-group-management-popover/);
  assert.match(markup, /app-frosted-popover/);
  assert.doesNotMatch(markup, /bg-slate-950\/70/);
  assert.match(markup, /Group management/);
  assert.match(markup, /Participants/);
  assert.match(markup, /Alice/);
  assert.match(markup, /Make admin/);
  assert.match(markup, /Add people/);
  assert.match(markup, /Rename/);
});

test('WorkspaceSidebar expanded participant space keeps contextual create on the first-page row and rich child previews', () => {
  const participantSpaces = buildParticipantSpaces(baseSidebarProps().chatConversations);
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    participantSpaces,
    filteredParticipantSpaces: participantSpaces,
    initialSelectedParticipantSpaceId: participantSpaces[0]?.id,
  }) as never));

  assert.doesNotMatch(markup, /Page 2/);
  assert.doesNotMatch(markup, /Back to chats/);
  assert.match(markup, /data-participant-space-row-actions="true"/);
  assert.match(markup, /aria-label="Create session in Bob"/);
  assert.match(markup, /data-participant-space-context-create="true"/);
  assert.match(markup, /data-session-preview="New preview"/);
  assert.match(markup, /data-session-updated-at="10:00"/);
});

test('WorkspaceSidebar selected group header exposes details and hashtag child sessions', () => {
  const chatConversations = [conversation({
    id: 'session:group-selected',
    canonicalSessionId: 'session:group-selected',
    name: 'Hi shu',
    participants: ['Me', 'Alice', 'Bob'],
    canonicalParticipants: [
      { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
      { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice' },
      { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
    ],
  })];
  const participantSpaces = buildParticipantSpaces(chatConversations);
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations,
    participantSpaces,
    filteredParticipantSpaces: participantSpaces,
    activeConvId: 'session:group-selected',
    initialSelectedParticipantSpaceId: participantSpaces[0]?.id,
  }) as never));

  assert.match(markup, /aria-label="Open group management"/);
  assert.match(markup, /data-participant-space-row-actions="true"/);
  assert.match(markup, /# Hi shu/);
});

test('WorkspaceSidebar names group spaces from people and hides agents from the participant row', () => {
  const chatConversations = [
    conversation({
      id: 'session:group-with-agent',
      canonicalSessionId: 'session:group-with-agent',
      name: 'hi shu',
      subtitle: 'session:bridge:humans:8e32e6b4-b8e7-4591-a412-8613ad09fe25',
      messages: [],
      participants: ['Me', 'shuyhere1', 'shuyhere2', 'Helper Kordi'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:shuyhere1', name: 'shuyhere1', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'shuyhere1' },
        { id: 'human:shuyhere2', name: 'shuyhere2', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'shuyhere2' },
        { id: 'agent:helper-kordi', name: 'Helper Kordi', kind: 'agent', role: 'delegate', source: 'bridge', avatarKey: 'helper-kordi' },
      ],
    }),
  ];
  const participantSpaces = buildParticipantSpaces(chatConversations);
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations,
    participantSpaces,
    filteredParticipantSpaces: participantSpaces,
    activeConvId: 'session:group-with-agent',
  }) as never));

  assert.match(markup, /shuyhere1, shuyhere2/);
  assert.match(markup, /aria-label="Expand shuyhere1, shuyhere2"/);
  assert.match(markup, /aria-label="Create session in shuyhere1, shuyhere2"/);
  assert.match(markup, /Group • 2 people • 1 session/);
  assert.doesNotMatch(markup, /Helper Kordi/);
  assert.doesNotMatch(markup, /session:bridge:humans/);
});
