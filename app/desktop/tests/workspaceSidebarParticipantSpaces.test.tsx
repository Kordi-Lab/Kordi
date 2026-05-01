import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { buildParticipantSpaces } from '../src/features/chat/participantSpaces';
import type { Agent, Contact, Conversation } from '../src/kordi-app/types';
import { ChatCreateDialog } from '../src/pages/ChatCreateDialog';
import { GroupDetailsDialog } from '../src/pages/GroupDetailsDialog';
import { participantSpaceSessionRowTitle, sessionContextMenuTargetForConversation, WorkspaceSidebar } from '../src/pages/WorkspaceSidebar';

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
  assert.match(markup, /data-participant-space-row-shell="true"/);
  assert.match(markup, /app-participant-space-row-button/);
  assert.match(markup, /app-participant-space-row-title/);
  assert.match(markup, /app-participant-space-row-preview/);
  assert.match(markup, /app-participant-space-row-detail/);
  assert.match(markup, /data-participant-space-toggle="true"/);
  assert.match(markup, /aria-label="Collapse Bob"/);
  assert.match(markup, /aria-label="Create session in Bob"/);
  assert.match(markup, /data-participant-space-context-create="true"/);
  assert.doesNotMatch(markup, /absolute right-1\.5 top-1\.5/);
  assert.doesNotMatch(markup, /pr-\[4\.75rem\]/);
  assert.doesNotMatch(markup, /data-participant-space-enter="true"/);
  assert.doesNotMatch(markup, /Back to chats/);
  assert.match(markup, /Old Bob thread/);
  assert.match(markup, /New Bob thread/);
});

test('WorkspaceSidebar moves participant-space unread totals between folded parent and expanded child sessions', () => {
  const chatConversations = [
    conversation({
      id: 'session:group:one',
      canonicalSessionId: 'session:group:one',
      name: 'First group thread',
      subtitle: 'First unread',
      unread: 2,
      participants: ['Me', 'Alice', 'Bob'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice' },
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
      ],
      _updatedAtMs: 1,
    }),
    conversation({
      id: 'session:group:two',
      canonicalSessionId: 'session:group:two',
      name: 'Second group thread',
      subtitle: 'Second unread',
      unread: 3,
      participants: ['Me', 'Alice', 'Bob'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice' },
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
      ],
      _updatedAtMs: 2,
    }),
  ];
  const participantSpaces = buildParticipantSpaces(chatConversations);
  const [space] = participantSpaces;

  const foldedMarkup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations,
    participantSpaces,
    filteredParticipantSpaces: participantSpaces,
    activeConvId: 'session:outside-active',
  }) as never));
  assert.match(foldedMarkup, /data-unread-scope="participant-space"[^>]*data-unread-count="5"/);
  assert.doesNotMatch(foldedMarkup, /data-unread-scope="participant-session"/);

  const expandedMarkup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations,
    participantSpaces,
    filteredParticipantSpaces: participantSpaces,
    initialSelectedParticipantSpaceId: space?.id,
    activeConvId: 'session:group:two',
  }) as never));
  assert.doesNotMatch(expandedMarkup, /data-unread-scope="participant-space"/);
  assert.match(expandedMarkup, /data-unread-scope="participant-session"[^>]*data-unread-count="2"/);
  assert.match(expandedMarkup, /data-unread-scope="participant-session"[^>]*data-unread-count="3"/);
});

test('participant-space row CSS separates the timestamp and actions while adding dense dividers', () => {
  const shellCss = readFileSync(new URL('../src/styles/shell.css', import.meta.url), 'utf8');

  assert.match(shellCss, /\.app-participant-space-row-shell\s*{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) max-content/s);
  assert.match(shellCss, /\.app-participant-space-row-actions\s*{[^}]*position:\s*static/s);
  assert.match(shellCss, /\.app-participant-space-row-actions\s*{[^}]*grid-template-columns:\s*repeat\(3, 1\.5rem\)/s);
  assert.match(shellCss, /\.app-participant-space-row-side\s*{[^}]*grid-template-rows:\s*max-content 1fr/s);
  assert.match(shellCss, /\.app-participant-space-row-meta\s*{[^}]*align-self:\s*end/s);
  assert.match(shellCss, /\.app-participant-space-inline-group\s*{[^}]*box-shadow:\s*inset 0 -1px 0/s);
  assert.match(shellCss, /\.app-participant-space-inline-group-expanded\s*{[^}]*background:\s*var\(--app-control-bg\);[^}]*box-shadow:\s*none/s);
  assert.match(shellCss, /\.app-participant-space-row-shell-active\s*{[^}]*border-color:\s*transparent;[^}]*background:\s*color-mix\(in oklab, var\(--app-control-active\) 68%, var\(--app-control-bg\)\);[^}]*box-shadow:\s*0 0 0 1px var\(--app-accent-ring\)/s);
  assert.match(shellCss, /\.app-participant-space-row-button\s*{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\)/s);
  assert.match(shellCss, /\.app-participant-space-row-button\s*{[^}]*padding:/s);
  assert.match(shellCss, /\.app-workspace-sidebar \.app-participant-space-row-button\s*{[^}]*display:\s*grid/s);
  assert.match(shellCss, /\.app-workspace-sidebar \.app-participant-space-row-detail\s*{[^}]*color:\s*color-mix\(in oklab, var\(--app-markdown-link\) 48%, var\(--utility-muted-text\)\)/s);
  assert.match(shellCss, /\.app-workspace-sidebar \.app-participant-space-session-row\s*{[^}]*border:\s*0;[^}]*border-radius:\s*8px/s);
  assert.match(shellCss, /\.app-workspace-sidebar \.app-participant-space-session-preview\s*{[^}]*color:\s*color-mix\(in oklab, var\(--utility-muted-text\) 62%, var\(--utility-foreground\)\)/s);
  assert.match(shellCss, /\.app-workspace-sidebar \.app-participant-space-session-row\.app-session-row-active\s*{[^}]*border:\s*0;[^}]*background:\s*color-mix\(in oklab, var\(--app-control-active\) 72%, var\(--app-control-bg\)\);[^}]*box-shadow:\s*none/s);
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
  assert.match(markup, /My chats/);
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

test('participant-space direct sessions expose archive and delete context menu targets', () => {
  const target = sessionContextMenuTargetForConversation(conversation({
    id: 'session:bridge:humans:shu',
    canonicalSessionId: 'session:bridge:humans:shu',
    name: 'Lunch planning',
    type: 'person',
  }), 42, 84);

  assert.deepEqual(target, {
    sessionId: 'session:bridge:humans:shu',
    sessionName: 'Lunch planning',
    x: 42,
    y: 84,
    canMoveToProject: false,
  });
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
  assert.doesNotMatch(markup, /lucide-ellipsis/);
  assert.match(markup, /Participants/);
  assert.match(markup, /Alice/);
  assert.match(markup, /Make admin/);
  assert.match(markup, /Add people/);
  assert.doesNotMatch(markup, />✓</);
  assert.match(markup, /data-add-contact-state="idle"[^>]*>Add</);
  assert.match(markup, /Rename/);
});

test('GroupDetailsDialog derives admins from group metadata instead of local self role', () => {
  const chatConversations = [conversation({
    id: 'session:group-admin-source',
    canonicalSessionId: 'session:group-admin-source',
    name: 'Bridge group',
    metadata: { adminIdentityIds: ['human:creator'], groupSpaceId: 'session:group-admin-source' },
    participants: ['Me', 'Testuser2', 'Testuser3'],
    canonicalParticipants: [
      { id: 'human:me', name: 'Testuser1', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
      { id: 'human:creator', name: 'Testuser2', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'testuser2' },
      { id: 'human:testuser3', name: 'Testuser3', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'testuser3' },
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

  assert.match(markup, /3 participants • 1 admin/);
  assert.match(markup, /Testuser2[\s\S]*?Admin/);
  assert.match(markup, /Testuser1[\s\S]*?Member/);
  assert.match(markup, /<button[^>]*disabled=""[^>]*>Rename<\/button>/);
  assert.match(markup, /<button[^>]*disabled=""[^>]*>Make admin<\/button>/);
});

test('GroupDetailsDialog falls back to canonical creator when admin metadata is missing', () => {
  const chatConversations = [conversation({
    id: 'session:group-legacy-admin',
    canonicalSessionId: 'session:group-legacy-admin',
    canonicalCreatedByIdentityId: 'human:me',
    name: 'Legacy group',
    metadata: { groupSpaceId: 'session:group-legacy-admin' },
    participants: ['Me', 'Testuser1', 'Testuser3'],
    canonicalParticipants: [
      { id: 'human:me', name: 'Testuser2', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
      { id: 'human:testuser1', name: 'Testuser1', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'testuser1' },
      { id: 'human:testuser3', name: 'Testuser3', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'testuser3' },
    ],
  })];
  const [space] = buildParticipantSpaces(chatConversations);
  const markup = renderToStaticMarkup(createElement(GroupDetailsDialog, {
    isOpen: true,
    space,
    contacts: [],
    onClose: () => {},
    onRename: () => {},
    onAddMembers: () => {},
    onRemoveMember: () => {},
    onSetAdmin: () => {},
  }));

  assert.match(markup, /3 participants • 1 admin/);
  assert.match(markup, /Testuser2[\s\S]*?Admin/);
  assert.doesNotMatch(markup, /<button[^>]*disabled=""[^>]*>Rename<\/button>/);
});

test('WorkspaceSidebar auto-expands the active My chats space with only the active session', () => {
  const chatConversations = [
    conversation({
      id: 'session:group:wrong',
      canonicalSessionId: 'session:group:wrong',
      name: 'Wrong group',
      participants: ['Me', 'Alice', 'Bob'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice' },
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
      ],
      _updatedAtMs: 3,
    }),
    conversation({
      id: 'session:self-agent:old-note',
      canonicalSessionId: 'session:self-agent:old-note',
      name: 'Old note',
      type: 'owned-agent',
      subtitle: 'Remember this',
      participants: ['Me', 'Reviewer'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'agent:reviewer', name: 'Reviewer', kind: 'agent', role: 'delegate', source: 'local', avatarKey: 'reviewer' },
      ],
      messages: [{ role: 'person', sender: 'Me', text: 'Remember this', time: '09:00' }],
      _updatedAtMs: 2,
    }),
    conversation({
      id: 'session:self-agent:selected-reviewer',
      canonicalSessionId: 'session:self-agent:selected-reviewer',
      name: 'Reviewer',
      type: 'owned-agent',
      subtitle: 'New session',
      participants: ['Me', 'Reviewer'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'agent:reviewer', name: 'Reviewer', kind: 'agent', role: 'delegate', source: 'local', avatarKey: 'reviewer' },
      ],
      messages: [],
      _updatedAtMs: 4,
    }),
  ];
  const participantSpaces = buildParticipantSpaces(chatConversations);
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations,
    participantSpaces,
    filteredParticipantSpaces: participantSpaces,
    activeConvId: 'session:self-agent:selected-reviewer',
    initialSelectedParticipantSpaceId: null,
  }) as never));

  assert.match(markup, /My chats/);
  assert.match(markup, /aria-label="Expand My chats"/);
  assert.match(markup, /# Reviewer/);
  assert.doesNotMatch(markup, /# Old note/);
});

test('WorkspaceSidebar explicit expansion shows all sessions in the active My chats space', () => {
  const chatConversations = [
    conversation({
      id: 'session:self-agent:old-note',
      canonicalSessionId: 'session:self-agent:old-note',
      name: 'Old note',
      type: 'owned-agent',
      subtitle: 'Remember this',
      participants: ['Me', 'Reviewer'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'agent:reviewer', name: 'Reviewer', kind: 'agent', role: 'delegate', source: 'local', avatarKey: 'reviewer' },
      ],
      messages: [{ role: 'person', sender: 'Me', text: 'Remember this', time: '09:00' }],
      _updatedAtMs: 2,
    }),
    conversation({
      id: 'session:self-agent:selected-reviewer',
      canonicalSessionId: 'session:self-agent:selected-reviewer',
      name: 'Reviewer',
      type: 'owned-agent',
      subtitle: 'New session',
      participants: ['Me', 'Reviewer'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'agent:reviewer', name: 'Reviewer', kind: 'agent', role: 'delegate', source: 'local', avatarKey: 'reviewer' },
      ],
      messages: [],
      _updatedAtMs: 4,
    }),
  ];
  const participantSpaces = buildParticipantSpaces(chatConversations);
  const notesSpace = participantSpaces.find((space) => space.kind === 'self');
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations,
    participantSpaces,
    filteredParticipantSpaces: participantSpaces,
    activeConvId: 'session:self-agent:selected-reviewer',
    initialSelectedParticipantSpaceId: notesSpace?.id,
  }) as never));

  assert.match(markup, /aria-label="Collapse My chats"/);
  assert.match(markup, /# Reviewer/);
  assert.match(markup, /# Old note/);
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
  assert.ok(markup.indexOf('aria-label="Open group management"') < markup.indexOf('aria-label="Create session in Alice, Bob"'));
  assert.match(markup, /data-participant-space-row-actions="true"/);
  assert.match(markup, /# Hi shu/);
});

test('WorkspaceSidebar aligns child session hashtags and keeps last-message metadata visible', () => {
  const chatConversations = [conversation({
    id: 'session:group-duplicate-preview',
    canonicalSessionId: 'session:group-duplicate-preview',
    name: '今天吃什么',
    subtitle: '今天吃什么',
    messages: [{ role: 'person', sender: 'Alice', text: '今天吃什么', time: '16:02' }],
    participants: ['Me', 'Alice', 'Bob'],
    canonicalMessageCount: 1,
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
    activeConvId: 'session:group-duplicate-preview',
    initialSelectedParticipantSpaceId: participantSpaces[0]?.id,
  }) as never));
  const shellCss = readFileSync(new URL('../src/styles/shell.css', import.meta.url), 'utf8');

  assert.doesNotMatch(markup, /pl-\[3\.25rem\]/);
  assert.match(markup, /# 今天吃什么/);
  assert.match(markup, /data-session-message-count="1"/);
  assert.match(markup, /data-session-preview-line="今天吃什么 · 1 message"/);
  assert.match(markup, /app-participant-space-session-preview/);
  assert.match(markup, /app-participant-space-session-title/);
  assert.match(shellCss, /\.app-workspace-sidebar \.app-participant-space-session-row\s*{[^}]*display:\s*grid/s);
  assert.match(shellCss, /\.app-participant-space-session-title\s*{[^}]*color:\s*color-mix\(in oklab, var\(--utility-foreground\) 88%, var\(--utility-muted-text\)\)/s);
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
  assert.match(markup, /Group • 3 people • 1 session/);
  assert.doesNotMatch(markup, /Helper Kordi/);
  assert.doesNotMatch(markup, /session:bridge:humans/);
});
