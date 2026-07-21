import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { readDesktopShellCss } from './helpers/readDesktopStyles';
import { buildParticipantSpaces } from '../src/features/chat/participantSpaces';
import { applyCloudPresenceToConversations, bridgeChatConversationRoutesToLocalAgentPage } from '../src/app/useWorkspaceViewModels';
import type { CloudAccount } from '../src/features/cloud/authClient';
import type { Agent, Contact, Conversation, DesktopBridgeConversation } from '../src/kordi-app/types';
import { ChatCreateDialog } from '../src/pages/ChatCreateDialog';
import {
  filterGroupManagementMembers,
  GroupDetailsDialog,
  groupManagementGeometry,
} from '../src/pages/GroupDetailsDialog';
import {
  contactForGroupMember,
  groupMemberAccountId,
  MemberContactProfileContent,
} from '../src/pages/MemberContactProfilePopover';
import { CloudProfileLogoutAction, participantSpaceSessionIdLabel, participantSpaceSessionRowTitle, sessionContextMenuTargetForConversation, WorkspaceSidebar } from '../src/pages/WorkspaceSidebar';

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

function bridgeConversation(overrides: Partial<DesktopBridgeConversation> = {}): DesktopBridgeConversation {
  return {
    id: 'bridge:host-1:node-bob:kordi-desktop',
    canonicalSessionId: 'session:bridge:host-1:node-bob:kordi-desktop',
    hostId: 'host-1',
    peerNodeId: 'node-bob',
    peerDisplayName: "Bob's Kordi",
    peerOwnerName: 'Bob',
    peerRuntime: 'kordi-desktop',
    projectId: null,
    projectName: null,
    title: 'Bob to my Kordi',
    subtitle: 'Please help',
    unreadCount: 1,
    updatedAtMs: 1,
    updatedAtLabel: '10:00',
    awaitingReply: false,
    peerTyping: false,
    outreach: {
      targetKind: 'bridge-agent',
      parentSessionId: null,
      bridgeHostId: 'host-1',
      targetNodeId: 'node-me',
      targetAgentId: 'agent-local',
      targetDisplayName: 'My Kordi',
      targetRuntime: 'kordi-desktop',
      requestText: 'Please help',
      status: 'awaitingReply',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identity: {
      bridgeHostId: 'host-1',
      localHumanId: 'human-me',
      localHumanName: 'Me',
      localAgentId: 'agent-local',
      localAgentName: 'My Kordi',
      remoteHumanId: 'human-bob',
      remoteHumanName: 'Bob',
    },
    messages: [],
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
    isDesktopChatLoading: false,
    desktopChatError: null,
    filteredConversations: chatConversations,
    contactParticipantSpaces: participantSpaces,
    agentParticipantSpaces: [],
    activeConvId: 'session:bob:new',
    onSelectChatSession: () => {},
    onStartChatWithPerson: () => {},
    onStartChatWithAgent: () => {},
    onCreateChatGroup: () => {},
    onAddContactByNodeId: () => {},
    onCreateChatSessionInParticipantSpace: () => {},
    onRenameChatGroup: () => {},
    onAddChatGroupMembers: () => {},
    onRemoveChatGroupMember: () => {},
    onSetChatGroupAdmin: () => {},
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
    addableContacts: [],
    contactRequestCount: 0,
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

test('WorkspaceSidebar cloud profile uses the provider image avatar instead of a generated pixel fallback', () => {
  const cloudAccount: CloudAccount = {
    accountId: 'acct_provider',
    displayName: 'Provider User',
    primaryEmail: 'provider@example.com',
    avatarUrl: 'https://lh3.googleusercontent.com/a/provider-avatar',
    nodeId: 'node-provider',
    passwordSet: false,
  };

  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    cloudAccount,
    onUpdateCloudProfile: async () => cloudAccount,
    localProfileAvatarSeed: 'stale-generated-local-seed',
  }) as never));

  const profileAvatarMarkup = markup.slice(markup.indexOf('aria-label="Provider User avatar"'), markup.indexOf('aria-label="Provider User avatar"') + 500);
  assert.match(profileAvatarMarkup, /src="https:\/\/lh3\.googleusercontent\.com\/a\/provider-avatar"/);
  assert.doesNotMatch(profileAvatarMarkup, /shape-rendering="crispEdges"/);
});

test('CloudProfileLogoutAction renders a destructive account logout menu item', () => {
  const markup = renderToStaticMarkup(createElement(CloudProfileLogoutAction, { onSignOut: async () => undefined }));

  assert.match(markup, /Logout/);
  assert.match(markup, /aria-label="Logout of account"/);
  assert.doesNotMatch(markup, />Cloud<\/span>/);
});

test('cloud presence hydrates account participants before chat rows are grouped', () => {
  const chatConversations = [conversation({
    canonicalParticipants: [
      { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me', humanId: 'acct_me' },
      { id: 'human:bob', name: 'Bob', kind: 'human', role: 'delegate', source: 'bridge', avatarKey: 'bob', humanId: 'acct_bob' },
    ],
  })];

  const hydrated = applyCloudPresenceToConversations(chatConversations, {
    acct_bob: { accountId: 'acct_bob', status: 'online', updatedAt: '2026-05-23T00:00:00Z' },
  });

  assert.equal(hydrated[0]?.canonicalParticipants?.[1]?.presenceStatus, 'online');
  assert.equal(buildParticipantSpaces(hydrated)[0]?.avatarStack[0]?.presenceStatus, 'online');
});

test('cloud presence hydrates fallback direct chat participants by account id', () => {
  const chatConversations = [conversation({
    canonicalParticipants: undefined,
    participants: ['Me', '333'],
    bridgeTarget: {
      hostId: 'cloud',
      nodeId: 'acct_333',
      displayName: '333',
      ownerName: '333',
      runtime: 'person',
      humanId: 'acct_333',
      agentId: null,
    },
    avatarSeed: 'acct_333',
  })];

  const hydrated = applyCloudPresenceToConversations(chatConversations, {
    acct_333: { accountId: 'acct_333', status: 'offline', updatedAt: '2026-05-23T00:00:00Z' },
  });

  assert.equal(buildParticipantSpaces(hydrated)[0]?.avatarStack[0]?.presenceStatus, 'offline');
});

test('WorkspaceSidebar shows participant presence lights in direct chat rows only', () => {
  const chatConversations = [conversation({
    canonicalParticipants: [
      { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me', presenceStatus: 'online' },
      { id: 'human:bob', name: 'Bob', kind: 'human', role: 'delegate', source: 'bridge', avatarKey: 'bob', presenceStatus: 'online' },
    ],
  })];
  const participantSpaces = buildParticipantSpaces(chatConversations);

  assert.equal(participantSpaces[0]?.avatarStack[0]?.presenceStatus, 'online');

  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations,
    filteredConversations: chatConversations,
    participantSpaces,
    contactParticipantSpaces: participantSpaces,
    activeConvId: chatConversations[0]?.id,
    initialSelectedParticipantSpaceId: participantSpaces[0]?.id,
  }) as never));

  assert.match(markup, /class="app-presence-light"/);
  assert.match(markup, /data-presence-status="online"/);
});

test('WorkspaceSidebar hides presence lights on group row avatar stacks', () => {
  const chatConversations = [conversation({
    id: 'session:group:presence-row',
    canonicalSessionId: 'session:group:presence-row',
    name: '111, 222',
    type: 'group',
    participants: ['Me', '111', '222'],
    canonicalParticipants: [
      { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me', presenceStatus: 'online' },
      { id: 'human:111', name: '111', kind: 'human', role: 'person', source: 'bridge', avatarKey: '111', presenceStatus: 'online' },
      { id: 'human:222', name: '222', kind: 'human', role: 'person', source: 'bridge', avatarKey: '222', presenceStatus: 'online' },
    ],
  })];
  const participantSpaces = buildParticipantSpaces(chatConversations);
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations,
    filteredConversations: chatConversations,
    participantSpaces,
    contactParticipantSpaces: participantSpaces,
    activeConvId: chatConversations[0]?.id,
    initialSelectedParticipantSpaceId: participantSpaces[0]?.id,
  }) as never));

  assert.match(markup, /111, 222/);
  assert.doesNotMatch(markup, /class="app-presence-light"/);
  assert.doesNotMatch(markup, /relative inline-flex shrink-0 h-7 w-7 border/);
});

test('WorkspaceSidebar renders direct human participant spaces as one flat chat row without session actions', () => {
  const participantSpaces = buildParticipantSpaces(baseSidebarProps().chatConversations);
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    participantSpaces,
    contactParticipantSpaces: participantSpaces,
    initialSelectedParticipantSpaceId: participantSpaces[0]?.id,
  }) as never));

  assert.match(markup, /data-chat-sidebar-mode="participant-spaces-inline"/);
  assert.match(markup, /app-filter-tab/);
  assert.match(markup, />Contact</);
  assert.match(markup, />Agent</);
  assert.doesNotMatch(markup, />People</);
  assert.match(markup, /Bob/);
  assert.match(markup, /New preview/);
  assert.doesNotMatch(markup, /Person • 1 chat/);
  assert.match(markup, /data-participant-space-row-shell="true"/);
  assert.match(markup, /app-participant-space-row-button/);
  assert.match(markup, /app-participant-space-row-title/);
  assert.match(markup, /app-participant-space-row-preview/);
  assert.doesNotMatch(markup, /app-participant-space-row-detail/);
  assert.doesNotMatch(markup, /data-participant-space-toggle="true"/);
  assert.doesNotMatch(markup, /aria-label="Collapse Bob"/);
  assert.doesNotMatch(markup, /aria-label="Expand Bob"/);
  assert.doesNotMatch(markup, /aria-label="Create session in Bob"/);
  assert.doesNotMatch(markup, /data-participant-space-context-create="true"/);
  assert.doesNotMatch(markup, /data-participant-space-toggle-button="true"/);
  assert.doesNotMatch(markup, /data-testid="participant-space-session-row"/);
  assert.doesNotMatch(markup, /absolute right-1\.5 top-1\.5/);
  assert.doesNotMatch(markup, /pr-\[4\.75rem\]/);
  assert.doesNotMatch(markup, /data-participant-space-enter="true"/);
  assert.doesNotMatch(markup, /Back to chats/);
  assert.doesNotMatch(markup, /Old Bob thread/);
  assert.doesNotMatch(markup, /New Bob thread/);
});

test('WorkspaceSidebar renders an Agent tab shortcut for new My agent sessions', () => {
  const chatConversations = [
    conversation({
      id: 'session:my-agent:new',
      canonicalSessionId: 'session:my-agent:new',
      name: 'My agent session',
      type: 'owned-agent',
      subtitle: 'New plan',
      participants: ['Me', 'My agent'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'agent:my-agent', name: 'My agent', kind: 'agent', role: 'delegate', source: 'local', avatarKey: 'my-agent' },
      ],
    }),
  ];
  const participantSpaces = buildParticipantSpaces(chatConversations);
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations,
    participantSpaces,
    contactParticipantSpaces: [],
    agentParticipantSpaces: participantSpaces,
    activeConvId: 'session:my-agent:new',
    initialChatChannel: 'agent',
  }) as never));

  assert.match(markup, />Agent</);
  assert.match(markup, /New My agent session/);
  assert.match(markup, /New session/);
});

test('WorkspaceSidebar marks the active agent fork path connector for accent styling', () => {
  const chatConversations = [
    conversation({
      id: 'session:agent:root',
      canonicalSessionId: 'session:agent:root',
      name: 'Root agent chat',
      type: 'owned-agent',
      subtitle: 'Root reply',
      unread: 0,
      participants: ['Me', 'My agent'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'agent:my-agent', name: 'My agent', kind: 'agent', role: 'delegate', source: 'local', avatarKey: 'my-agent' },
      ],
      _updatedAtMs: 1,
    }),
    conversation({
      id: 'session:agent:fork',
      canonicalSessionId: 'session:agent:fork',
      name: 'Forked agent chat',
      type: 'owned-agent',
      subtitle: 'Fork reply',
      unread: 0,
      forkedFromSessionId: 'session:agent:root',
      forkedFromMessageId: 'msg:root-agent',
      participants: ['Me', 'My agent'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'agent:my-agent', name: 'My agent', kind: 'agent', role: 'delegate', source: 'local', avatarKey: 'my-agent' },
      ],
      _updatedAtMs: 2,
    }),
  ];
  const participantSpaces = buildParticipantSpaces(chatConversations);
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations,
    participantSpaces,
    contactParticipantSpaces: [],
    agentParticipantSpaces: participantSpaces,
    activeConvId: 'session:agent:fork',
    initialChatChannel: 'agent',
  }) as never));

  assert.match(markup, /data-session-fork-path-active="true"/);
  assert.match(markup, /app-session-fork-children-active/);
});

test('WorkspaceSidebar keeps agent session hashtags aligned with fork controls on the right', () => {
  const chatConversations = [
    conversation({
      id: 'session:agent:root-align',
      canonicalSessionId: 'session:agent:root-align',
      name: 'Root agent chat',
      type: 'owned-agent',
      subtitle: 'Root reply',
      unread: 0,
      participants: ['Me', 'My agent'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'agent:my-agent', name: 'My agent', kind: 'agent', role: 'delegate', source: 'local', avatarKey: 'my-agent' },
      ],
      _updatedAtMs: 1,
    }),
    conversation({
      id: 'session:agent:fork-align',
      canonicalSessionId: 'session:agent:fork-align',
      name: 'Forked agent chat',
      type: 'owned-agent',
      subtitle: 'Fork reply',
      unread: 0,
      forkedFromSessionId: 'session:agent:root-align',
      forkedFromMessageId: 'msg:root-agent',
      participants: ['Me', 'My agent'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'agent:my-agent', name: 'My agent', kind: 'agent', role: 'delegate', source: 'local', avatarKey: 'my-agent' },
      ],
      _updatedAtMs: 2,
    }),
  ];
  const participantSpaces = buildParticipantSpaces(chatConversations);
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations,
    participantSpaces,
    contactParticipantSpaces: [],
    agentParticipantSpaces: participantSpaces,
    activeConvId: 'session:agent:root-align',
    initialChatChannel: 'agent',
  }) as never));
  const rootRowStart = markup.indexOf('data-agent-session-row="session:agent:root-align"');
  const rootRowMarkup = markup.slice(rootRowStart, markup.indexOf('</button>', rootRowStart));
  const titleIndex = rootRowMarkup.indexOf('app-session-row-title');
  const toggleIndex = rootRowMarkup.indexOf('app-agent-session-fork-toggle');
  const shellCss = readDesktopShellCss();

  assert.match(rootRowMarkup, /app-agent-session-main/);
  assert.match(rootRowMarkup, /app-agent-session-side/);
  assert.match(rootRowMarkup, /app-agent-session-fork-toggle/);
  assert.ok(titleIndex >= 0, 'agent session title should render');
  assert.ok(toggleIndex > titleIndex, 'agent fork toggle should render to the right of the title');
  assert.doesNotMatch(rootRowMarkup.slice(0, titleIndex), /app-agent-session-fork-toggle/);
  assert.match(shellCss, /\.app-workspace-sidebar \.app-agent-session-row\s*{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) max-content/s);
});

test('WorkspaceSidebar does not show an Agent tab unread badge for hidden canonical parent forks', () => {
  const chatConversations = [
    conversation({
      id: 'session:fork:hidden-contact-child',
      canonicalSessionId: 'session:fork:hidden-contact-child',
      name: 'Forked group continuation',
      type: 'owned-agent',
      subtitle: 'Unread hidden fork',
      unread: 1,
      forkedFromSessionId: 'session:group:cloud-parent',
      forkedFromMessageId: 'msg:source',
      participants: ['Me', 'My agent'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'agent:my-agent', name: 'My agent', kind: 'agent', role: 'delegate', source: 'local', avatarKey: 'my-agent' },
      ],
    }),
  ];
  const participantSpaces = buildParticipantSpaces(chatConversations);
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations,
    participantSpaces,
    contactParticipantSpaces: [],
    agentParticipantSpaces: participantSpaces,
    activeConvId: '',
    initialChatChannel: 'agent',
  }) as never));

  assert.match(markup, /No agent conversations yet/);
  assert.doesNotMatch(markup, /data-unread-scope="channel-tab" data-unread-count="1"/);
});

test('WorkspaceSidebar hides group-derived fork unread from the contact tab and folded group row', () => {
  const chatConversations = [
    conversation({
      id: 'session:group:cloud-parent',
      canonicalSessionId: 'session:group:cloud-parent',
      name: 'Cloud group',
      type: 'group',
      subtitle: 'Parent group',
      unread: 0,
      participants: ['Me', 'Alice', 'Bob'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice' },
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
      ],
      _updatedAtMs: 2,
    }),
    conversation({
      id: 'session:fork:hidden-contact-child',
      canonicalSessionId: 'session:fork:hidden-contact-child',
      name: 'Forked group continuation',
      type: 'owned-agent',
      subtitle: 'Unread hidden fork',
      unread: 1,
      forkedFromSessionId: 'session:group:cloud-parent',
      forkedFromMessageId: 'msg:source',
      participants: ['Me', 'My agent'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'agent:my-agent', name: 'My agent', kind: 'agent', role: 'delegate', source: 'local', avatarKey: 'my-agent' },
      ],
      _updatedAtMs: 1,
    }),
  ];
  const participantSpaces = buildParticipantSpaces(chatConversations);
  const contactParticipantSpaces = participantSpaces.filter((space) => space.kind === 'group');
  const agentParticipantSpaces = participantSpaces.filter((space) => space.kind === 'self');
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations,
    participantSpaces,
    contactParticipantSpaces,
    agentParticipantSpaces,
    activeConvId: 'session:outside-active',
  }) as never));

  assert.doesNotMatch(markup, /data-unread-scope="channel-tab" data-unread-count="1"/);
  assert.doesNotMatch(markup, /data-unread-scope="participant-space" data-unread-count="1"/);
});

function countMatches(value: string, pattern: RegExp) {
  return value.match(pattern)?.length ?? 0;
}

test('WorkspaceSidebar shows Bridge message sync progress inline in the chats subtitle', () => {
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    isBridgePolling: true,
  }) as never));

  assert.match(markup, /2 total/);
  assert.match(markup, /syncing…/);
  assert.match(markup, /data-bridge-sync-status="syncing"/);
  assert.match(markup, /app-bridge-sync-dot/);
  assert.doesNotMatch(markup, /Syncing messages/);
  assert.doesNotMatch(markup, /pulling missed Bridge updates/);
});

test('direct remote-human to my-agent Bridge reachouts route to the Agent page, while group reachouts stay in the group', () => {
  assert.equal(bridgeChatConversationRoutesToLocalAgentPage(bridgeConversation()), true);
  assert.equal(bridgeChatConversationRoutesToLocalAgentPage(bridgeConversation({
    outreach: {
      ...bridgeConversation().outreach!,
      parentSessionId: 'session:group:launch',
      parentSessionKind: 'group',
    },
  })), false);
  assert.equal(bridgeChatConversationRoutesToLocalAgentPage(bridgeConversation({
    outreach: {
      ...bridgeConversation().outreach!,
      targetAgentId: 'agent-remote',
    },
  })), false);
});

test('Cloud self-agent reachouts stay in the contact chat rail instead of routing away to the Agent page', () => {
  assert.equal(bridgeChatConversationRoutesToLocalAgentPage(bridgeConversation({
    id: 'bridge:cloud:acct-peer:person',
    canonicalSessionId: 'session:bridge:bridge:cloud:acct-peer:person',
    hostId: 'cloud',
    outreach: {
      ...bridgeConversation().outreach!,
      bridgeHostId: 'cloud',
      bridgeConversationId: 'bridge:cloud:acct-peer:person',
      targetAgentId: 'agent-local',
    },
  })), false);
});

test('WorkspaceSidebar keeps the inline Bridge sync status calm when idle', () => {
  const caughtUpConversations = [
    conversation({ id: 'chat-1', name: 'Alice', unread: 0 }),
    conversation({ id: 'chat-2', name: 'Bob', unread: 0 }),
  ];
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations: caughtUpConversations,
    isBridgePolling: false,
  }) as never));

  assert.match(markup, /2 total/);
  assert.match(markup, /all caught up/);
  assert.match(markup, /data-bridge-sync-status="idle"/);
  assert.doesNotMatch(markup, /syncing…/);
});

test('WorkspaceSidebar moves participant-space unread totals between folded parent and unread child sessions', () => {
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
    contactParticipantSpaces: participantSpaces,
    activeConvId: 'session:outside-active',
  }) as never));
  assert.match(foldedMarkup, /data-unread-scope="participant-space"[^>]*data-unread-count="5"/);
  assert.doesNotMatch(foldedMarkup, /data-unread-scope="participant-session"/);

  const expandedMarkup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations,
    participantSpaces,
    contactParticipantSpaces: participantSpaces,
    initialSelectedParticipantSpaceId: space?.id,
    activeConvId: 'session:group:two',
  }) as never));
  assert.doesNotMatch(expandedMarkup, /data-unread-scope="participant-space"/);
  assert.match(expandedMarkup, /data-unread-scope="participant-session"[^>]*data-unread-count="2"/);
  assert.doesNotMatch(expandedMarkup, /data-unread-scope="participant-session"[^>]*data-unread-count="3"/);
});

test('WorkspaceSidebar moves participant-space running light from expanded parent to child session', () => {
  const chatConversations = [
    conversation({
      id: 'session:group:one',
      canonicalSessionId: 'session:group:one',
      name: 'First group thread',
      participants: ['Me', 'Alice', 'Bob'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice' },
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
      ],
      statusIndicator: { label: 'Processing', tone: 'running', live: true },
      _updatedAtMs: 2,
    }),
    conversation({
      id: 'session:group:two',
      canonicalSessionId: 'session:group:two',
      name: 'Second group thread',
      participants: ['Me', 'Alice', 'Bob'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice' },
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
      ],
      _updatedAtMs: 1,
    }),
  ];
  const participantSpaces = buildParticipantSpaces(chatConversations);
  const [space] = participantSpaces;

  const foldedMarkup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations,
    participantSpaces,
    contactParticipantSpaces: participantSpaces,
    activeConvId: 'session:outside-active',
  }) as never));
  assert.equal(countMatches(foldedMarkup, /app-session-status-light-running/g), 1);

  const expandedMarkup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations,
    participantSpaces,
    contactParticipantSpaces: participantSpaces,
    initialSelectedParticipantSpaceId: space?.id,
    activeConvId: 'session:group:one',
  }) as never));
  assert.equal(countMatches(expandedMarkup, /app-session-status-light-running/g), 1);
});

test('direct participant-space rows still highlight when their session is active', () => {
  const chatConversations = [
    conversation({
      id: 'session:bob:active',
      canonicalSessionId: 'session:bob:active',
      name: 'Bob',
      subtitle: 'Active direct chat',
      participants: ['Me', 'Bob'],
      _updatedAtMs: 2,
    }),
  ];
  const participantSpaces = buildParticipantSpaces(chatConversations);
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations,
    participantSpaces,
    contactParticipantSpaces: participantSpaces,
    filteredConversations: chatConversations,
    activeConvId: 'session:bob:active',
  }) as never));

  assert.match(
    markup,
    /app-participant-space-row-shell[^"&]*app-session-row-active|app-session-row-active[^"&]*app-participant-space-row-shell/,
    'active direct sessions should apply the active highlight to the full row shell, including the timestamp column',
  );
  assert.match(markup, /app-participant-space-row-shell-selected/, 'active direct session shell should use the selected participant-row style');
  assert.doesNotMatch(
    markup,
    /app-participant-space-row-button[^"&]*app-session-row-active|app-session-row-active[^"&]*app-participant-space-row-button/,
    'active direct session highlight must not be limited to the inner button column',
  );
  assert.equal(countMatches(markup, /app-session-row-active/g), 1, 'only the visible active direct session row should be highlighted');
});

test('participant-space parent rows are not styled as the active session row', () => {
  const source = readFileSync(new URL('../src/pages/WorkspaceSidebar.tsx', import.meta.url), 'utf8');
  const renderStart = source.indexOf('const renderParticipantSpaceItem = (space: ParticipantSpaceItem) => {');
  const renderEnd = source.indexOf('const renderParticipantSpaceList =', renderStart);
  assert.notEqual(renderStart, -1, 'expected participant-space renderer');
  assert.notEqual(renderEnd, -1, 'expected end of participant-space renderer');
  const renderer = source.slice(renderStart, renderEnd);

  assert.doesNotMatch(
    renderer,
    /app-participant-space-row-shell-active/,
    'participant-space parent shells should not reuse active-session styling',
  );
  assert.match(
    renderer,
    /isExpanded[\s\S]*app-participant-space-row-shell-expanded/,
    'expanded parent rows should use a separate expanded state',
  );
});

test('participant-space parent row primary click selects a session while chevron toggles expansion', () => {
  const source = readFileSync(new URL('../src/pages/WorkspaceSidebar.tsx', import.meta.url), 'utf8');
  const selectHelperStart = source.indexOf('const selectParticipantSpacePrimarySession = (space: ParticipantSpaceItem) => {');
  assert.notEqual(selectHelperStart, -1, 'expected primary parent-row selection helper');
  const selectHelper = source.slice(selectHelperStart, source.indexOf('\n    };', selectHelperStart));
  assert.match(selectHelper, /onSelectChatSession\(latestSession\.id\)/, 'primary parent click should select the latest session in one click');

  const renderStart = source.indexOf('const renderParticipantSpaceItem = (space: ParticipantSpaceItem) => {');
  const renderEnd = source.indexOf('const renderParticipantSpaceList =', renderStart);
  const renderer = source.slice(renderStart, renderEnd);
  assert.match(renderer, /onClick=\{\(\) => selectParticipantSpacePrimarySession\(space\)\}/, 'parent row button should select, not toggle');
  assert.match(renderer, /data-participant-space-toggle-button="true"[\s\S]*toggleSpace\(\)/, 'chevron remains the explicit expand-collapse control');
});

test('participant-space row CSS separates the timestamp and actions while adding dense dividers', () => {
  const shellCss = readDesktopShellCss();
  const themeOverrideCss = readFileSync(new URL('../src/styles/theme-overrides.css', import.meta.url), 'utf8');
  const themeTokensCss = readFileSync(new URL('../src/styles/theme-tokens.css', import.meta.url), 'utf8');

  assert.match(shellCss, /\.app-participant-space-row-shell\s*{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) max-content[^}]*border:\s*0;[^}]*border-radius:\s*0;/s);
  assert.match(shellCss, /\.app-participant-space-row-actions\s*{[^}]*position:\s*static/s);
  assert.match(shellCss, /\.app-participant-space-row-actions\s*{[^}]*grid-template-columns:\s*repeat\(3, 1\.5rem\)/s);
  assert.match(shellCss, /\.app-participant-space-row-side\s*{[^}]*grid-template-rows:\s*max-content;/s);
  assert.doesNotMatch(shellCss, /\.app-participant-space-row-side\s*{[^}]*grid-template-rows:\s*max-content 1fr/s);
  assert.match(shellCss, /\.app-participant-space-row-side\s*{[^}]*min-height:\s*3\.125rem/s);
  assert.doesNotMatch(shellCss, /\.app-participant-space-row-side\s*{[^}]*min-height:\s*4\.05rem/s);
  assert.match(shellCss, /\.app-participant-space-row-meta\s*{[^}]*align-self:\s*start/s);
  assert.doesNotMatch(shellCss, /\.app-participant-space-row-meta\s*{[^}]*align-self:\s*end/s);
  assert.match(shellCss, /\.app-participant-space-inline-group\s*{[^}]*border-radius:\s*0;[^}]*box-shadow:\s*none/s);
  assert.match(shellCss, /\.app-participant-space-inline-group-expanded\s*{[^}]*background:\s*transparent;[^}]*box-shadow:\s*none/s);
  assert.match(shellCss, /\.app-participant-space-row-shell-expanded\s*{[^}]*background:\s*color-mix\(in oklab, var\(--app-sidebar-selected-bg\) 38%, transparent\);[^}]*box-shadow:\s*none/s);
  assert.match(shellCss, /\.app-participant-space-row-shell-selected\s*{[^}]*background:\s*var\(--app-sidebar-selected-bg\)/s);
  assert.doesNotMatch(shellCss, /\.app-participant-space-row-shell-expanded\s*{[^}]*border-color:\s*color-mix\(in oklab, var\(--app-accent-ring\)/s);
  assert.match(shellCss, /\.app-participant-space-row-button\s*{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\)/s);
  assert.match(shellCss, /\.app-participant-space-row-button\s*{[^}]*padding:/s);
  assert.match(shellCss, /\.app-workspace-sidebar \.app-participant-space-row-button\s*{[^}]*display:\s*grid/s);
  assert.match(shellCss, /\.app-workspace-sidebar \.app-participant-space-row-detail\s*{[^}]*color:\s*var\(--app-sidebar-time-text\)/s);
  assert.match(shellCss, /\.app-workspace-sidebar \.app-participant-space-row-title\s*{[^}]*color:\s*var\(--app-sidebar-title-text\);[^}]*font-weight:\s*600/s);
  assert.match(shellCss, /\.app-workspace-sidebar \.app-session-row-title\s*{[^}]*color:\s*var\(--app-sidebar-title-text\);[^}]*font-weight:\s*600/s);
  assert.match(shellCss, /\.app-workspace-sidebar \.app-session-meta-time\s*{[^}]*color:\s*var\(--app-sidebar-time-text\);[^}]*font-weight:\s*400/s);
  assert.match(shellCss, /\.app-workspace-sidebar \.app-sidebar-unread-badge\s*{[^}]*background:\s*var\(--app-sidebar-accent\);[^}]*color:\s*var\(--app-sidebar-accent-text\);[^}]*box-shadow:\s*none/s);
  assert.match(shellCss, /\.app-session-row\s*{[^}]*border:\s*0;[^}]*border-radius:\s*0;/s);
  assert.match(shellCss, /\.app-workspace-sidebar \.app-session-row\s*{[^}]*border-radius:\s*0;/s);
  assert.match(shellCss, /\.app-workspace-sidebar \.app-filter-tab-active\s*{[^}]*background:\s*var\(--app-sidebar-selected-bg\);[^}]*box-shadow:\s*none/s);
  assert.match(shellCss, /\.app-workspace-sidebar \.app-session-row:hover\s*{[^}]*background:\s*color-mix\(in oklab, var\(--app-sidebar-selected-bg\) 72%, transparent\)/s);
  assert.match(shellCss, /\.app-workspace-sidebar \.app-participant-space-session-row\s*{[^}]*min-height:\s*2\.875rem;[^}]*border:\s*0;[^}]*border-radius:\s*0;/s);
  assert.match(shellCss, /\.app-workspace-sidebar \.app-participant-space-session-preview\s*{[^}]*color:\s*var\(--app-sidebar-preview-text\)/s);
  assert.match(shellCss, /\.app-workspace-sidebar \.app-participant-space-session-row\.app-session-row-active\s*{[^}]*background:\s*var\(--app-sidebar-selected-bg\);[^}]*box-shadow:\s*none;/s);
  assert.doesNotMatch(shellCss, /\.app-workspace-sidebar \.app-participant-space-session-row\.app-session-row-active\s*{[^}]*0 8px 18px/s);
  assert.match(shellCss, /\.app-participant-space-inline-group:not\(\.app-participant-space-inline-group-expanded\) \.app-participant-space-row-actions\s*{[^}]*opacity:\s*0\.46/s);
  assert.match(themeTokensCss, /\.bridge-app\s*{[^}]*--app-sidebar-title-text:\s*rgb\(248 250 252\);[^}]*--app-sidebar-preview-text:\s*rgb\(148 163 184\);[^}]*--app-sidebar-time-text:\s*rgb\(100 116 139\);[^}]*--app-sidebar-accent:\s*#60A5FA;[^}]*--app-sidebar-selected-bg:\s*rgba\(37, 99, 235, 0\.18\);/s);
  assert.match(themeTokensCss, /\.bridge-app\.theme-light\s*{[^}]*--app-sidebar-title-text:\s*#111827;[^}]*--app-sidebar-preview-text:\s*#6B7280;[^}]*--app-sidebar-time-text:\s*#9CA3AF;[^}]*--app-sidebar-accent:\s*#2563EB;[^}]*--app-sidebar-selected-bg:\s*#EEF4FF;/s);
  assert.match(themeOverrideCss, /\.bridge-app\.theme-light \.app-session-row-active\s*{[^}]*background:\s*var\(--app-sidebar-selected-bg\);[^}]*box-shadow:\s*none;/s);
  assert.doesNotMatch(themeOverrideCss, /\.bridge-app\.theme-light \.app-workspace-sidebar \.app-session-row-active,[\s\S]*?\{\s*box-shadow:\s*none;/s);
});

test('Bridge sync subtitle CSS uses color and reduced-motion-safe animation', () => {
  const shellCss = readDesktopShellCss();

  assert.match(shellCss, /\.app-bridge-sync-status\s*{[^}]*color:\s*color-mix\(in oklab, var\(--app-markdown-link\) 68%, var\(--utility-muted-text\)\)/s);
  assert.match(shellCss, /\.app-bridge-sync-dot\s*{[^}]*background:\s*conic-gradient/s);
  assert.match(shellCss, /\.app-bridge-sync-status\[data-bridge-sync-status="syncing"\]\s+\.app-bridge-sync-dot\s*{[^}]*animation:\s*app-bridge-sync-pulse/s);
  assert.match(shellCss, /@media \(prefers-reduced-motion: reduce\)\s*{[^}]*\.app-bridge-sync-status\[data-bridge-sync-status="syncing"\]\s+\.app-bridge-sync-dot\s*{[^}]*animation:\s*none/s);
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
    contactParticipantSpaces: participantSpaces,
    activeConvId: 'session:shu-agent',
  }) as never));

  assert.match(markup, /shu/);
  assert.doesNotMatch(markup, /Person • 1 chat/);
  assert.match(markup, /My chats/);
  assert.match(markup, /Personal • 2 sessions/);
  assert.doesNotMatch(markup, /Person \+ 1 agent/);
  assert.doesNotMatch(markup, /Myself \+ 2 agents/);
  assert.doesNotMatch(markup, /Group • 1 session/);
});

test('WorkspaceSidebar uses menu for the global plus and agent picker for Agent-tab New session', () => {
  const source = readFileSync(new URL('../src/pages/WorkspaceSidebar.tsx', import.meta.url), 'utf8');
  const dialogSource = readFileSync(new URL('../src/pages/ChatCreateDialog.tsx', import.meta.url), 'utf8');

  assert.match(source, /const \[chatCreateInitialMode, setChatCreateInitialMode\] = useState<ChatCreateMode>\('menu'\)/);
  assert.match(source, /const openChatCreateDialog = \(event: ReactMouseEvent<HTMLElement>\) => \{[\s\S]*setChatCreateInitialMode\('menu'\);[\s\S]*setIsChatCreateDialogOpen\(true\);[\s\S]*\};/);
  assert.match(source, /setChatCreateInitialMode\('agent'\);[\s\S]*setIsChatCreateDialogOpen\(true\);/);
  assert.match(source, /initialMode=\{chatCreateInitialMode\}/);
  assert.doesNotMatch(source, /initialMode=\{chatChannel === 'agent' \? 'agent' : 'menu'\}/);
  assert.match(dialogSource, /if \(isOpen\) \{\s*setMode\(initialMode\);\s*\}/);
});

test('ChatCreateDialog agent mode shows agent choices with avatars directly', () => {
  const markup = renderToStaticMarkup(createElement(ChatCreateDialog, {
    isOpen: true,
    initialMode: 'agent',
    contacts: [contact({ id: 'contact:alice', name: 'Alice' })],
    agents: [
      agent({ id: 'agent:kordi', name: 'Kordi', role: 'Personal agent', avatarSeed: 'local-kordi' }),
      agent({
        id: 'cloud-agent:cloud_agent_abc',
        name: 'Kordi Project Driver',
        role: 'Project planning agent',
        cloudAgentId: 'cloud_agent_abc',
        avatarSeed: 'cloud_agent_abc',
        profileImageUrl: 'https://example.test/project-driver.png',
      }),
    ],
    onClose: () => {},
    onStartPerson: () => {},
    onStartAgent: () => {},
    onCreateGroup: () => {},
  }));

  assert.match(markup, /Chat with agent/);
  assert.match(markup, /Kordi Project Driver/);
  assert.match(markup, /Personal agent/);
  assert.match(markup, /data-avatar-kind="agent"/);
  assert.match(markup, /project-driver\.png/);
  assert.doesNotMatch(markup, /Chat with contact/);
  assert.doesNotMatch(markup, /Start group/);
  assert.doesNotMatch(markup, /Add contacts/);
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
  assert.match(markup, /Chat with contact/);
  assert.doesNotMatch(markup, /Chat with person/);
  assert.match(markup, /Chat with agent/);
  assert.match(markup, /Start group/);
  assert.match(markup, /Add contacts/);
});

test('ChatCreateDialog cloud lookup copy asks for an account id, not a Bridge node id', () => {
  const markup = renderToStaticMarkup(createElement(ChatCreateDialog, {
    isOpen: true,
    initialMode: 'add-contact',
    contacts: [],
    agents: [],
    onClose: () => {},
    onStartPerson: () => {},
    onStartAgent: () => {},
    onCreateGroup: () => {},
    onAddContact: () => {},
    onLookupContact: async () => null,
    addContactPlaceholder: 'Account ID, e.g. acct_…',
  }));

  assert.match(markup, /Add contact/);
  assert.match(markup, /Kordi account ID/);
  assert.match(markup, /Account ID, e.g. acct_…/);
  assert.doesNotMatch(markup, /Bridge node ID/);
});

test('ChatCreateDialog add contact mode requests a private Bridge node id', () => {
  const markup = renderToStaticMarkup(createElement(ChatCreateDialog, {
    isOpen: true,
    initialMode: 'add-contact',
    contacts: [],
    agents: [],
    onClose: () => {},
    onStartPerson: () => {},
    onStartAgent: () => {},
    onCreateGroup: () => {},
    onAddContact: () => {},
  }));

  assert.match(markup, /Add contact/);
  assert.match(markup, /Bridge node ID/);
  assert.match(markup, /Send request/);
  assert.match(markup, /private\/unlisted user node ID/);
});

test('ChatCreateDialog add contact mode shows visible non-contact Bridge users', () => {
  const markup = renderToStaticMarkup(createElement(ChatCreateDialog, {
    isOpen: true,
    initialMode: 'add-contact',
    contacts: [],
    addableContacts: [
      contact({
        id: 'bridge-addable:kordi-user-6',
        name: 'Kordi User 6',
        entityType: 'Person',
        subtitle: 'Needs approval',
        detail: 'Node: kd_user6',
        bridgeHostId: 'host-1',
        bridgePeerNodeId: 'kd_user6',
        bridgeContactStatus: 'none',
      }),
    ],
    agents: [],
    onClose: () => {},
    onStartPerson: () => {},
    onStartAgent: () => {},
    onCreateGroup: () => {},
    onAddContact: () => {},
  }));

  assert.match(markup, /Visible users/);
  assert.match(markup, /Kordi User 6/);
  assert.match(markup, /Needs approval/);
  assert.match(markup, /Request/);
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

test('participant-space child session rows use hashtag titles and hide raw session ids', () => {
  assert.equal(participantSpaceSessionRowTitle('Hi shu'), '# Hi shu');
  assert.equal(participantSpaceSessionRowTitle('# Existing'), '# Existing');
  assert.equal(participantSpaceSessionIdLabel({ id: 'session:group:child', canonicalSessionId: 'session:group:root' }), 'Group chat');
});

test('participant-space direct sessions expose remove-chat context menu targets', () => {
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

test('GroupDetailsDialog renders a searchable member gallery with progressive controls', () => {
  const chatConversations = [conversation({
    id: 'session:group-details',
    canonicalSessionId: 'session:group-details',
    name: 'Design crew',
    metadata: { adminIdentityIds: ['human:me'], groupSpaceId: 'session:group-details', customName: 'Design crew' },
    participants: ['Me', 'Alice', 'Bob'],
    canonicalParticipants: [
      { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
      { id: 'human:alice', name: 'Alice', kind: 'human', role: 'admin', source: 'bridge', avatarKey: 'alice', presenceStatus: 'online' },
      { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob', presenceStatus: 'offline' },
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
  assert.match(markup, /app-group-management-header[^"\n]*shrink-0/);
  assert.match(markup, /app-transient-scroll[^"\n]*overflow-y-auto/);
  assert.doesNotMatch(markup, /bg-slate-950\/70/);
  assert.match(markup, /Group management/);
  assert.doesNotMatch(markup, /lucide-ellipsis/);
  assert.doesNotMatch(markup, />People<\/h3>/);
  assert.match(markup, /placeholder="Search members"/);
  assert.match(markup, /data-group-member-grid/);
  assert.match(markup, /Alice/);
  assert.match(markup, /class="app-presence-light"/);
  assert.match(markup, /data-presence-status="online"/);
  assert.match(markup, /lucide-star/);
  assert.doesNotMatch(markup, />Admin<\/span>|>Member<\/span>|>People<\/span>/);
  assert.match(markup, /aria-label="Add people"/);
  assert.doesNotMatch(markup, /No additional approved contacts available/);
  assert.match(markup, /Group name/);
  assert.doesNotMatch(markup, /Group notice|Mute notifications|Sticky|Local alias|Search chat history/);
  assert.doesNotMatch(markup, /Make group admin/);
  assert.doesNotMatch(markup, /Remove from group/);
});

test('GroupDetailsDialog keeps the member gallery to five compact columns and four rows until Show all is used', () => {
  const canonicalParticipants = [
    { id: 'human:me', name: 'Me', kind: 'human' as const, role: 'self' as const, source: 'local' as const, avatarKey: 'me' },
    ...Array.from({ length: 19 }, (_, index) => ({
      id: `human:member-${index + 1}`,
      name: `Member ${index + 1}`,
      kind: 'human' as const,
      role: 'person' as const,
      source: 'bridge' as const,
      avatarKey: `member-${index + 1}`,
    })),
  ];
  const [space] = buildParticipantSpaces([conversation({
    id: 'session:group-many-members',
    canonicalSessionId: 'session:group-many-members',
    name: 'Large group',
    metadata: {
      adminIdentityIds: ['human:me'],
      groupCreatorIdentityId: 'human:me',
      groupSpaceId: 'session:group-many-members',
    },
    participants: canonicalParticipants.map((participant) => participant.name),
    canonicalParticipants,
  })]);
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

  assert.equal(markup.match(/data-group-member-grid-item/g)?.length, 20);
  assert.match(markup, /Show all/);
  assert.match(markup, /aria-expanded="false"/);
  assert.match(markup, /h-9 w-9/);
  assert.doesNotMatch(markup, /Member 19/);
  assert.ok(
    markup.indexOf('aria-label="Member 18, member"') < markup.indexOf('aria-label="Add people"'),
    'Add people should occupy the final (20th) collapsed-grid slot',
  );
  assert.match(
    readDesktopShellCss(),
    /\.app-group-management-member-grid\s*\{[^}]*grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/s,
  );
  assert.match(
    readDesktopShellCss(),
    /\.app-group-management-member-tile-selected\s*\{[^}]*background:\s*var\(--app-sidebar-selected-bg\);[^}]*box-shadow:\s*none;/s,
  );
});

test('GroupDetailsDialog labels the canonical group-root creation date instead of session activity', () => {
  const rootCreatedAtMs = new Date(2026, 5, 3, 12).getTime();
  const participants = [
    { id: 'human:me', name: 'Me', kind: 'human' as const, role: 'self' as const, source: 'local' as const, avatarKey: 'me' },
    { id: 'human:alice', name: 'Alice', kind: 'human' as const, role: 'person' as const, source: 'bridge' as const, avatarKey: 'alice' },
    { id: 'human:bob', name: 'Bob', kind: 'human' as const, role: 'person' as const, source: 'bridge' as const, avatarKey: 'bob' },
  ];
  const [space] = buildParticipantSpaces([
    conversation({
      id: 'session:group:created-root',
      canonicalSessionId: 'session:group:created-root',
      canonicalCreatedAtMs: rootCreatedAtMs,
      canonicalCreatedByIdentityId: 'human:me',
      metadata: { groupSpaceId: 'session:group:created-root', adminIdentityIds: ['human:me'] },
      canonicalParticipants: participants,
      participants: participants.map((participant) => participant.name),
      updatedAtLabel: '02:45',
      _updatedAtMs: rootCreatedAtMs + 10_000,
    }),
    conversation({
      id: 'session:group:created-child',
      canonicalSessionId: 'session:group:created-child',
      canonicalCreatedAtMs: rootCreatedAtMs + 20_000,
      canonicalCreatedByIdentityId: 'human:me',
      metadata: { groupSpaceId: 'session:group:created-root', continuedFromSessionId: 'session:group:created-root' },
      canonicalParticipants: participants,
      participants: participants.map((participant) => participant.name),
      updatedAtLabel: '14:30',
      _updatedAtMs: rootCreatedAtMs + 30_000,
    }),
  ]);
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

  assert.equal(space.createdAtMs, rootCreatedAtMs);
  assert.match(markup, /Created 2026-06-03/);
  assert.doesNotMatch(markup, /Created 02:45|Created 14:30/);
});

test('GroupDetailsDialog geometry stays tall, narrow, and inside small and large viewports', () => {
  const desktop = groupManagementGeometry(
    { left: 120, top: 90, width: 28, height: 28 },
    { width: 1280, height: 800 },
  );
  assert.equal(desktop.style.width, 372);
  assert.equal(desktop.style.maxHeight, 760);
  assert.equal(desktop.style.height, undefined);
  assert.ok(Number(desktop.style.left) >= 12);
  assert.ok(Number(desktop.style.top) >= 12);
  assert.ok(Number(desktop.style.left) + Number(desktop.style.width) <= 1268);
  assert.ok(Number(desktop.style.top) + Number(desktop.style.maxHeight) <= 788);

  const compact = groupManagementGeometry(
    { left: 8, top: 8, width: 24, height: 24 },
    { width: 320, height: 420 },
  );
  assert.equal(compact.style.width, 296);
  assert.equal(compact.style.maxHeight, 396);
  assert.equal(compact.style.height, undefined);
  assert.equal(compact.style.left, 12);
  assert.equal(compact.style.top, 12);

  const centered = groupManagementGeometry(
    { left: 320, top: 180, width: 32, height: 32 },
    { width: 680, height: 600 },
  );
  assert.equal(centered.placement, 'floating');
  assert.equal(centered.style.left, 154);
  assert.equal(centered.style.top, 12);
});

test('GroupDetailsDialog member filtering stays bounded and useful with 50 people', () => {
  const members = Array.from({ length: 50 }, (_, index) => ({
    id: `human:${index}`,
    humanId: `acct_${index}`,
    name: index === 37 ? 'Jiaxin Pei' : `Member ${index + 1}`,
    kind: 'human' as const,
    role: 'person' as const,
    source: 'bridge' as const,
    avatarKey: `member-${index}`,
  }));

  assert.equal(filterGroupManagementMembers(members, '').length, 50);
  assert.deepEqual(filterGroupManagementMembers(members, 'jiaxin').map((member) => member.id), ['human:37']);
  assert.deepEqual(filterGroupManagementMembers(members, 'acct_9').map((member) => member.id), ['human:9']);
});

test('GroupDetailsDialog resolves a group-only member to the account used by Add to contacts', () => {
  const member = {
    id: 'human:acct_group_member',
    humanId: 'acct_group_member',
    bridgeNodeId: 'acct_group_member',
    name: 'Group member',
    kind: 'human' as const,
    role: 'person' as const,
    source: 'bridge' as const,
    avatarKey: 'group-member',
  };
  const groupOnlyContact = contact({
    id: 'cloud:acct_group_member',
    bridgeHostId: 'cloud',
    bridgePeerNodeId: 'acct_group_member',
    bridgeHumanId: 'acct_group_member',
    bridgeContactStatus: 'group-member',
  });

  const resolvedContact = contactForGroupMember([groupOnlyContact], member);
  assert.equal(resolvedContact?.id, groupOnlyContact.id);
  assert.equal(groupMemberAccountId(member, resolvedContact), 'acct_group_member');
});

test('existing group contact profile offers Send message instead of a passive contact label', () => {
  const member = {
    id: 'human:acct_alice',
    humanId: 'acct_alice',
    bridgeNodeId: 'acct_alice',
    name: 'Alice',
    kind: 'human' as const,
    role: 'person' as const,
    source: 'bridge' as const,
    avatarKey: 'alice',
  };
  const acceptedContact = contact({
    id: 'cloud:acct_alice',
    bridgeHostId: 'cloud',
    bridgePeerNodeId: 'acct_alice',
    bridgeHumanId: 'acct_alice',
    bridgeContactStatus: 'accepted',
  });

  const markup = renderToStaticMarkup(createElement(MemberContactProfileContent, {
    participant: member,
    contacts: [acceptedContact],
    onMessageContact: () => undefined,
  }));

  assert.match(markup, />Send message</);
  assert.match(markup, /data-member-contact-action="message"/);
  assert.match(markup, /aria-label="Send message to Alice"/);
  assert.match(markup, /title="Send message"/);
  assert.match(markup, /class="sr-only">Send message</);
  assert.match(markup, /Works on product/);
  assert.doesNotMatch(markup, />In contacts</);
  assert.doesNotMatch(markup, />Add to contacts</);
  assert.doesNotMatch(markup, /Kordi ID|acct_alice/);
  const actionClass = /data-member-contact-action="message" class="([^"]+)"/.exec(markup)?.[1] ?? '';
  assert.ok(actionClass);
  assert.doesNotMatch(actionClass, /\bw-full\b/);
  assert.match(actionClass, /\bh-8\b/);
  assert.match(actionClass, /\bw-8\b/);
});

test('GroupDetailsDialog treats the signed-in account id as an alias of the local self identity', () => {
  const [space] = buildParticipantSpaces([conversation({
    id: 'session:group-account-admin',
    canonicalSessionId: 'session:group-account-admin',
    canonicalCreatedByIdentityId: 'acct_me',
    name: 'Account alias group',
    metadata: {
      groupSpaceId: 'session:group-account-admin',
      groupCreatorIdentityId: 'acct_me',
      adminIdentityIds: ['acct_me'],
    },
    participants: ['Me', 'Alice'],
    canonicalParticipants: [
      { id: 'human:local-profile', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
      { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice' },
    ],
  })]);
  const markup = renderToStaticMarkup(createElement(GroupDetailsDialog, {
    isOpen: true,
    space,
    contacts: [contact({ id: 'contact:bob', name: 'Bob' })],
    currentAccountId: 'acct_me',
    onClose: () => {},
    onRename: () => {},
    onAddMembers: () => {},
    onRemoveMember: () => {},
    onSetAdmin: () => {},
  }));

  assert.match(markup, /2 people · 1 admin/);
  assert.match(markup, /aria-label="Me, admin"/);
  assert.match(markup, /aria-label="Add people"/);
});

test('GroupDetailsDialog keeps Add people after the final member for a regular member', () => {
  const [space] = buildParticipantSpaces([conversation({
    id: 'session:group-open-invites',
    canonicalSessionId: 'session:group-open-invites',
    canonicalCreatedByIdentityId: 'human:jiaxin',
    name: 'Open invite group',
    metadata: {
      groupSpaceId: 'session:group-open-invites',
      groupCreatorIdentityId: 'human:jiaxin',
      adminIdentityIds: ['human:jiaxin'],
      memberApprovalPolicy: 'under-50-open',
    },
    participants: ['Jiaxin Pei', 'Me', 'C UFishAI', 'Shenzhe Zhu', 'Alice', 'Bob'],
    canonicalParticipants: [
      { id: 'human:jiaxin', name: 'Jiaxin Pei', kind: 'human', role: 'admin', source: 'bridge', avatarKey: 'jiaxin' },
      { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
      { id: 'human:ufish', name: 'C UFishAI', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'ufish' },
      { id: 'human:shenzhe', name: 'Shenzhe Zhu', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'shenzhe' },
      { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice' },
      { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
    ],
  })]);
  const markup = renderToStaticMarkup(createElement(GroupDetailsDialog, {
    isOpen: true,
    space,
    contacts: [contact({ id: 'contact:bob', name: 'Bob' })],
    onClose: () => {},
    onRename: () => {},
    onAddMembers: () => {},
    onRemoveMember: () => {},
    onSetAdmin: () => {},
  }));

  assert.equal(markup.match(/data-group-member-grid-item/g)?.length, 7);
  assert.match(markup, /aria-label="Me, member"/);
  assert.match(markup, /aria-label="Add people"/);
  assert.ok(
    markup.indexOf('aria-label="Bob, member"') < markup.indexOf('aria-label="Add people"'),
    'Add people should follow every member when the full gallery fits',
  );
});

test('GroupDetailsDialog ignores a child session that falsely promotes its local creator', () => {
  const chatConversations = [
    conversation({
      id: 'session:group:root',
      canonicalSessionId: 'session:group:root',
      canonicalCreatedByIdentityId: 'human:old-admin',
      name: '1111',
      metadata: { adminIdentityIds: ['human:old-admin'], groupSpaceId: 'session:group:root', customName: '1111' },
      participants: ['Me', 'Old Admin', 'Shu Yang'],
      _updatedAtMs: 1,
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:old-admin', name: 'Old Admin', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'old' },
        { id: 'human:acct_new', name: 'Shu Yang', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'new', humanId: 'acct_new', bridgeNodeId: 'acct_new', bridgeHostId: 'cloud' },
      ],
    }),
    conversation({
      id: 'session:group:child',
      canonicalSessionId: 'session:group:child',
      canonicalCreatedByIdentityId: 'human:acct_new',
      name: '1111',
      metadata: { adminIdentityIds: ['human:acct_new'], groupSpaceId: 'session:group:root', customName: '1111' },
      participants: ['Me', 'Old Admin', 'Shu Yang'],
      _updatedAtMs: 2,
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:old-admin', name: 'Old Admin', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'old' },
        { id: 'human:acct_new', name: 'Shu Yang', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'new', humanId: 'acct_new', bridgeNodeId: 'acct_new', bridgeHostId: 'cloud' },
      ],
    }),
  ];
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

  assert.match(markup, /3 people · 1 admin/);
  assert.match(markup, /aria-label="Shu Yang, member"/);
  assert.match(markup, /aria-label="Old Admin, admin"/);
});

test('GroupDetailsDialog uses the newest replicated admin revision for demotions', () => {
  const participants = [
    { id: 'human:creator', name: 'Creator', kind: 'human' as const, role: 'person', source: 'bridge' as const, avatarKey: 'creator' },
    { id: 'human:me', name: 'Me', kind: 'human' as const, role: 'self', source: 'local' as const, avatarKey: 'me' },
    { id: 'human:alice', name: 'Alice', kind: 'human' as const, role: 'person', source: 'bridge' as const, avatarKey: 'alice' },
  ];
  const [space] = buildParticipantSpaces([
    conversation({
      id: 'session:group:admin-root',
      canonicalSessionId: 'session:group:admin-root',
      canonicalCreatedByIdentityId: 'human:creator',
      metadata: {
        groupSpaceId: 'session:group:admin-root',
        groupCreatorIdentityId: 'human:creator',
        adminIdentityIds: ['human:creator'],
        groupAdminUpdatedAtMs: 20,
      },
      canonicalParticipants: participants,
      participants: ['Creator', 'Me', 'Alice'],
      _updatedAtMs: 1,
    }),
    conversation({
      id: 'session:group:admin-child',
      canonicalSessionId: 'session:group:admin-child',
      canonicalCreatedByIdentityId: 'human:me',
      metadata: {
        groupSpaceId: 'session:group:admin-root',
        adminIdentityIds: ['human:creator', 'human:alice'],
        groupAdminUpdatedAtMs: 10,
      },
      canonicalParticipants: participants,
      participants: ['Creator', 'Me', 'Alice'],
      _updatedAtMs: 2,
    }),
  ]);
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

  assert.match(markup, /3 people · 1 admin/);
  assert.match(markup, /aria-label="Creator, admin"/);
  assert.match(markup, /aria-label="Alice, member"/);
});

test('GroupDetailsDialog disambiguates same-name members before progressively opening add contacts', () => {
  const chatConversations = [conversation({
    id: 'session:group:same-name',
    canonicalSessionId: 'session:group:same-name',
    name: 'Same names',
    metadata: { adminIdentityIds: ['human:me'], groupSpaceId: 'session:group:same-name' },
    participants: ['Me', 'Shu Yang'],
    canonicalParticipants: [
      { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
      { id: 'human:acct_a', name: 'Shu Yang', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'a', humanId: 'acct_a', bridgeNodeId: 'acct_a', bridgeHostId: 'cloud' },
    ],
  })];
  const [space] = buildParticipantSpaces(chatConversations);
  const markup = renderToStaticMarkup(createElement(GroupDetailsDialog, {
    isOpen: true,
    space,
    contacts: [contact({ id: 'cloud:acct_b', name: 'Shu Yang', bridgeHostId: 'cloud', bridgePeerNodeId: 'acct_b', bridgeHumanId: 'acct_b', bridgeContactStatus: 'accepted' })],
    onClose: () => {},
    onRename: () => {},
    onAddMembers: () => {},
    onRemoveMember: () => {},
    onSetAdmin: () => {},
  }));

  assert.match(markup, /acct_a/);
  assert.doesNotMatch(markup, /acct_b/);
  assert.match(markup, /aria-label="Add people"/);
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

  assert.match(markup, /3 people · 1 admin/);
  assert.match(markup, /aria-label="Testuser2, admin"/);
  assert.match(markup, /aria-label="Testuser1, member"/);
  assert.match(markup, /<button[^>]*disabled=""[^>]*aria-expanded="false"[^>]*>[\s\S]*?Group name/);
  assert.match(markup, /aria-label="Add people"/);
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

  assert.match(markup, /3 people · 1 admin/);
  assert.match(markup, /aria-label="Testuser2, admin"/);
  assert.doesNotMatch(markup, /<button[^>]*disabled=""[^>]*aria-expanded="false"[^>]*>[\s\S]*?Group name/);
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
    contactParticipantSpaces: participantSpaces,
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
    contactParticipantSpaces: participantSpaces,
    activeConvId: 'session:self-agent:selected-reviewer',
    initialSelectedParticipantSpaceId: notesSpace?.id,
  }) as never));

  assert.match(markup, /aria-label="Collapse My chats"/);
  assert.match(markup, /# Reviewer/);
  assert.match(markup, /# Old note/);
});

test('WorkspaceSidebar expanded group space keeps contextual create on the first-page row and rich child previews', () => {
  const chatConversations = [
    conversation({
      id: 'session:group:old',
      canonicalSessionId: 'session:group:old',
      name: 'Old group thread',
      subtitle: 'Old group preview',
      participants: ['Me', 'Alice', 'Bob'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice' },
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
      ],
      _updatedAtMs: 1,
    }),
    conversation({
      id: 'session:group:new',
      canonicalSessionId: 'session:group:new',
      name: 'New group thread',
      subtitle: 'New group preview',
      participants: ['Me', 'Alice', 'Bob'],
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice' },
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
      ],
      messages: [{ role: 'person', sender: 'Alice', text: 'New group preview', time: '10:00' }],
      updatedAtLabel: '10:00',
      _updatedAtMs: 2,
    }),
  ];
  const participantSpaces = buildParticipantSpaces(chatConversations);
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations,
    participantSpaces,
    contactParticipantSpaces: participantSpaces,
    initialSelectedParticipantSpaceId: participantSpaces[0]?.id,
  }) as never));

  assert.doesNotMatch(markup, /Page 2/);
  assert.doesNotMatch(markup, /Back to chats/);
  assert.match(markup, /data-participant-space-row-actions="true"/);
  assert.match(markup, /aria-label="Create session in Alice, Bob"/);
  assert.match(markup, /data-participant-space-context-create="true"/);
  assert.match(markup, /data-session-preview="New group preview"/);
  assert.match(markup, /data-session-updated-at="10:00"/);
});

test('WorkspaceSidebar grays and disables group create while a blank New chat already exists', () => {
  const renderCreateButton = (hasMessage: boolean) => {
    const chatConversations = [conversation({
      id: 'session:group:new-chat',
      canonicalSessionId: 'session:group:new-chat',
      canonicalMessageCount: hasMessage ? 1 : 0,
      name: 'New chat',
      subtitle: hasMessage ? 'Start the topic' : '',
      messages: hasMessage
        ? [{ role: 'person', sender: 'Me', text: 'Start the topic', time: '16:05' }]
        : [],
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
      contactParticipantSpaces: participantSpaces,
      activeConvId: 'session:group:new-chat',
      initialSelectedParticipantSpaceId: participantSpaces[0]?.id,
    }) as never));
    const marker = markup.indexOf('data-participant-space-context-create="true"');
    const buttonStart = markup.lastIndexOf('<button', marker);
    return markup.slice(buttonStart, markup.indexOf('</button>', marker));
  };

  const disabledButton = renderCreateButton(false);
  const enabledButton = renderCreateButton(true);
  const shellCss = readDesktopShellCss();

  assert.match(disabledButton, /disabled=""/);
  assert.match(disabledButton, /aria-label="New session unavailable in Alice, Bob: a blank chat already exists"/);
  assert.doesNotMatch(enabledButton, /disabled=""/);
  assert.match(shellCss, /\.app-participant-space-context-create:disabled[\s\S]*?cursor:\s*not-allowed;[\s\S]*?opacity:\s*0\.38;/);
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
    contactParticipantSpaces: participantSpaces,
    activeConvId: 'session:group-selected',
    initialSelectedParticipantSpaceId: participantSpaces[0]?.id,
  }) as never));
  const sessionRowStart = markup.indexOf('data-testid="participant-space-session-row"');
  const sessionRowMarkup = markup.slice(sessionRowStart, markup.indexOf('</button>', sessionRowStart));

  assert.match(markup, /aria-label="Open group management"/);
  assert.ok(markup.indexOf('aria-label="Open group management"') < markup.indexOf('aria-label="Create session in Alice, Bob"'));
  assert.match(markup, /data-participant-space-row-actions="true"/);
  assert.match(markup, /# Hi shu/);
  assert.match(sessionRowMarkup, /data-session-id-label="Group chat"/);
  assert.doesNotMatch(sessionRowMarkup, /app-participant-space-session-id/);
  assert.doesNotMatch(sessionRowMarkup, />Group chat<\//);
});

test('WorkspaceSidebar group child titles avoid native tooltips that destabilize hover', () => {
  const chatConversations = [conversation({
    id: 'session:group-hover-stable',
    canonicalSessionId: 'session:group-hover-stable',
    name: 'Stable hover',
    type: 'group',
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
    contactParticipantSpaces: participantSpaces,
    activeConvId: 'session:group-hover-stable',
    initialSelectedParticipantSpaceId: participantSpaces[0]?.id,
  }) as never));
  const sessionRowStart = markup.indexOf('data-testid="participant-space-session-row"');
  const sessionRowMarkup = markup.slice(sessionRowStart, markup.indexOf('</button>', sessionRowStart));

  assert.match(sessionRowMarkup, /app-participant-space-session-title[^>]*># Stable hover<\/span>/);
  assert.doesNotMatch(sessionRowMarkup, /app-participant-space-session-title[^>]*\stitle=/);
});

test('WorkspaceSidebar keeps group child host rows mounted across parent refreshes', () => {
  const source = readFileSync(new URL('../src/pages/WorkspaceSidebar.tsx', import.meta.url), 'utf8');
  const workspaceStart = source.indexOf('export function WorkspaceSidebar({');
  const workspaceEnd = source.indexOf('\nexport ', workspaceStart + 1);
  const workspace = source.slice(workspaceStart, workspaceEnd < 0 ? undefined : workspaceEnd);

  assert.doesNotMatch(workspace, /const ParticipantSpaceSessionRow\s*=\s*\(/);
  assert.match(workspace, /const renderParticipantSpaceSessionRow\s*=\s*\(\s*session:\s*ParticipantSpaceItem\['sessions'\]\[number\],/);
  assert.match(workspace, /return row \? renderParticipantSpaceSessionRow\(row\.session, descriptor\.depth\) : null;/);
});

test('WorkspaceSidebar hides old fork rows for canonical group sessions', () => {
  const chatConversations = [
    conversation({
      id: 'session:group:weather',
      canonicalSessionId: 'session:group:weather',
      name: 'Weather group',
      subtitle: 'Weather group',
      messages: [{ role: 'person', sender: 'Alice', text: 'Weather group', time: '16:02' }],
      participants: ['Me', 'Alice', 'Bob'],
      canonicalMessageCount: 1,
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice' },
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
      ],
    }),
    conversation({
      id: 'session:fork:group-weather',
      canonicalSessionId: 'session:fork:group-weather',
      name: 'Old group fork',
      subtitle: 'Fork continuation',
      messages: [{ role: 'person', sender: 'Bob', text: 'Fork continuation', time: '16:05' }],
      participants: ['Me', 'Alice', 'Bob'],
      unread: 7,
      canonicalMessageCount: 2,
      forkedFromSessionId: 'session:group:weather',
      forkedFromMessageId: 'msg:source',
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice' },
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
      ],
    }),
  ];
  const participantSpaces = buildParticipantSpaces(chatConversations);
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations,
    participantSpaces,
    contactParticipantSpaces: participantSpaces,
    activeConvId: 'session:group:weather',
    initialSelectedParticipantSpaceId: participantSpaces[0]?.id,
  }) as never));

  assert.match(markup, /Weather group/);
  assert.doesNotMatch(markup, /Old group fork/);
  assert.doesNotMatch(markup, /app-participant-space-session-fork-toggle/);
  assert.doesNotMatch(markup, /app-participant-space-session-fork-marker/);
  assert.doesNotMatch(markup, /data-unread-count="7"/);
});

test('WorkspaceSidebar aligns child session hashtags and keeps last-message metadata visible', () => {
  const chatConversations = [
    conversation({
      id: 'session:group-duplicate-preview',
      canonicalSessionId: 'session:group-duplicate-preview',
      name: 'Dinner plans',
      subtitle: 'Dinner plans',
      messages: [{ role: 'person', sender: 'Alice', text: 'Dinner plans', time: '16:02' }],
      participants: ['Me', 'Alice', 'Bob'],
      canonicalMessageCount: 1,
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice' },
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
      ],
    }),
    conversation({
      id: 'session:group-duplicate-preview:fork',
      canonicalSessionId: 'session:group-duplicate-preview:fork',
      name: 'Tomorrow plans',
      subtitle: 'Fork continuation',
      messages: [{ role: 'person', sender: 'Bob', text: 'Fork continuation', time: '16:05' }],
      participants: ['Me', 'Alice', 'Bob'],
      canonicalMessageCount: 2,
      forkedFromSessionId: 'session:group-duplicate-preview',
      forkedFromMessageId: 'msg:source',
      canonicalParticipants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local', avatarKey: 'me' },
        { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'alice' },
        { id: 'human:bob', name: 'Bob', kind: 'human', role: 'person', source: 'bridge', avatarKey: 'bob' },
      ],
    }),
  ];
  const participantSpaces = buildParticipantSpaces(chatConversations);
  const markup = renderToStaticMarkup(createElement(WorkspaceSidebar, baseSidebarProps({
    chatConversations,
    participantSpaces,
    contactParticipantSpaces: participantSpaces,
    activeConvId: 'session:group-duplicate-preview',
    initialSelectedParticipantSpaceId: participantSpaces[0]?.id,
  }) as never));
  const shellCss = readDesktopShellCss();

  assert.doesNotMatch(markup, /pl-\[3\.25rem\]/);
  assert.match(markup, /# Dinner plans/);
  assert.match(markup, /data-session-message-count="1"/);
  assert.match(markup, /data-session-preview-line="Dinner plans · 1 message"/);
  assert.match(markup, /data-session-id-label="Group chat"/);
  assert.doesNotMatch(markup, /Session ID: session:group-duplicate-preview/);
  assert.match(markup, /app-participant-space-session-preview/);
  assert.match(markup, /app-participant-space-session-title/);
  assert.match(markup, /app-participant-space-session-side/);
  assert.match(markup, /app-participant-space-session-fork-toggle/);
  assert.match(markup, /app-participant-space-session-fork-marker/);
  assert.match(markup, /app-participant-space-session-main[^>]*>[\s\S]*?app-participant-space-session-title[\s\S]*?app-participant-space-session-side[\s\S]*?app-participant-space-session-fork-toggle/);
  assert.match(markup, /app-participant-space-session-main[^>]*>[\s\S]*?app-participant-space-session-title[\s\S]*?app-participant-space-session-side[\s\S]*?app-participant-space-session-fork-marker/);
  assert.match(shellCss, /\.app-workspace-sidebar \.app-participant-space-session-row\s*{[^}]*display:\s*grid/s);
  assert.match(shellCss, /\.app-workspace-sidebar \.app-participant-space-session-main\s*{[^}]*min-width:\s*0/s);
  assert.match(shellCss, /\.app-workspace-sidebar \.app-participant-space-session-side\s*{[^}]*display:\s*inline-flex/s);
  assert.match(shellCss, /\.app-participant-space-session-title\s*{[^}]*color:\s*var\(--app-sidebar-title-text\);[^}]*font-weight:\s*600/s);
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
    contactParticipantSpaces: participantSpaces,
    activeConvId: 'session:group-with-agent',
  }) as never));

  assert.match(markup, /shuyhere1, shuyhere2/);
  assert.match(markup, /aria-label="Expand shuyhere1, shuyhere2"/);
  assert.match(markup, /aria-label="Create session in shuyhere1, shuyhere2"/);
  assert.match(markup, /Group • 3 people • 1 session/);
  assert.doesNotMatch(markup, /Helper Kordi/);
  assert.doesNotMatch(markup, /session:bridge:humans/);
});
