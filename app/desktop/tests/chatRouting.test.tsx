import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { assembleMainContentSlot } from '../src/app/assembleMainContentSlot';
import { assembleSidebarSlot } from '../src/app/assembleSidebarSlot';
import { buildBridgePageProps } from '../src/app/mainContentShellBuilders';
import { visibleLocalSessionIdForActivity } from '../src/app/useKordiDesktopActivity';
import { bridgeChatConversationIsVisible, useWorkspaceViewModels } from '../src/app/useWorkspaceViewModels';
import { createCanonicalSessionReadModel } from '../src/features/canonical/sessionReadModel';

function directPersonConversation() {
  return {
    id: 'session:bridge:humans:bob',
    canonicalSessionId: 'session:bridge:humans:bob',
    name: 'Bob',
    type: 'person',
    subtitle: '',
    unread: 0,
    bridges: ['Bridge'],
    trust: 'Bridge',
    directness: 'Direct chat',
    participants: ['Me', 'Bob'],
    canonicalParticipants: [{
      id: 'human:bob',
      name: 'Bob',
      kind: 'human',
      role: 'delegate',
      source: 'bridge',
      bridgeNodeId: 'node-shared',
      humanId: 'human-bob',
    }],
    messages: [],
  };
}

function directAgentConversation() {
  return {
    id: 'session:bridge:agents:bob-agent',
    canonicalSessionId: 'session:bridge:agents:bob-agent',
    name: 'Bob agent',
    type: 'external-agent',
    subtitle: '',
    unread: 0,
    bridges: ['Bridge'],
    trust: 'Bridge',
    directness: 'Agent thread',
    participants: ['Me', 'Bob agent'],
    canonicalParticipants: [{
      id: 'agent:bob',
      name: 'Bob agent',
      kind: 'agent',
      role: 'delegate',
      source: 'bridge',
      bridgeNodeId: 'node-shared',
      agentId: 'agent-bob',
    }],
    messages: [],
  };
}

function baseSidebarArgs(overrides: Record<string, unknown> = {}) {
  return {
    isNativeShell: true,
    isSingleWorkspacePage: false,
    collapseChatSessions: false,
    showSessionRail: true,
    sessionRailWidth: 320,
    activeNav: 'chats',
    setActiveNav: () => {},
    chatConversations: [],
    handleCreateChatSession: async () => {},
    chatSearch: '',
    setChatSearch: () => {},
    chatFilter: 'all',
    setChatFilter: () => {},
    isDesktopChatLoading: false,
    desktopChatError: null,
    filteredConversations: [],
    participantSpaces: [],
    filteredParticipantSpaces: [],
    activeConvId: '',
    handleSelectChatSession: async () => {},
    handleStartChatWithPerson: async () => {},
    handleStartChatWithAgent: async () => {},
    handleCreateChatGroup: async () => {},
    handleRenameChatGroup: async () => {},
    handleAddChatGroupMembers: async () => {},
    handleRemoveChatGroupMember: async () => {},
    handleSetChatGroupAdmin: async () => {},
    handleArchiveChatSession: async () => {},
    handleDeleteChatSession: async () => {},
    handleMoveChatSessionToProject: async () => {},
    handleCreateProjectFromFolder: async () => {},
    handleCreateProject: async () => {},
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
    handleSelectProjectSession: async () => {},
    groupedContacts: [],
    displayedContacts: [],
    setActiveContactGroup: () => {},
    setActiveContactId: () => {},
    displayedAgents: [],
    activeBridgeHost: null,
    localProfileAvatarSeed: null,
    refreshDesktopBridge: async () => {},
    handleCopyBridgeText: async () => {},
    handleCreateBridgeDraft: () => {},
    ...overrides,
  };
}

function baseShellArgs(calls: string[], overrides: Record<string, unknown> = {}) {
  return {
    activeNav: 'contacts',
    chatConversations: [directPersonConversation()],
    setActiveNav: (nav: string) => calls.push(`nav:${nav}`),
    handleSelectChatSession: async (sessionId: string) => { calls.push(`select:${sessionId}`); },
    handleOpenBridgeConversation: async () => { calls.push('openBridge'); },
    handleStartBridgePersonSession: async (target: Record<string, unknown>) => { calls.push(`startPerson:${target.hostId}:${target.nodeId}:${target.humanId}`); },
    setContactOverlayMode: (value: unknown) => calls.push(`overlay:${String(value)}`),
    displayedAgents: [],
    filteredGroupedContacts: [],
    contactRequests: [],
    activeContact: {},
    activeContactRequest: {},
    getStatusBadgeClass: () => '',
    desktopBridgeState: null,
    activeBridgePeople: [],
    activeBridgeAgents: [],
    handleCreateChatSession: async () => { calls.push('createLocal'); },
    setIsContactRequestsOpen: () => {},
    setExpandedContactGroups: () => {},
    setActiveContactGroup: () => {},
    setActiveContactId: () => {},
    setActiveAgentId: () => {},
    setIsAgentOverlayOpen: () => {},
    handleSelectBridgeHost: async () => {},
    handleCreateBridgeDraft: () => {},
    refreshDesktopBridge: async () => {},
    handleSaveBridgeSettings: async () => {},
    handleRemoveBridgeHost: async () => {},
    handleCopyBridgeText: async () => {},
    handleOpenBridgeConfigFolder: async () => {},
    handleRevealBridgeStorageFile: async () => {},
    handleExportBridgeHostsConfig: async () => {},
    handleImportBridgeHostsConfig: async () => {},
    handleAddBridgeContact: async () => {},
    handleSetBridgeDiscoveryMode: async () => {},
    handleCreateBridgeAgent: async () => {},
    handleActivateBridgeAgent: async () => {},
    handleSetDefaultBridgeAgent: async () => {},
    handleRemoveBridgeContact: async () => {},
    handleBridgeWizardPrimary: async () => {},
    handleCreateProjectSession: async () => {},
    handleRenameDesktopSession: async () => {},
    handleStopDesktopChatTurn: async () => {},
    handleSendChatMessage: async () => {},
    handleSendProjectMessage: async () => {},
    openAuthSettings: () => {},
    selectComposerValue: async () => {},
    selectAuthProvider: () => {},
    openLoginFlow: async () => {},
    refreshDesktopAuth: async () => {},
    handleSelectAuthChoice: async () => {},
    handleRemoveAuthProfile: async () => {},
    handleLogoutProvider: async () => {},
    handleCreateProject: async () => {},
    handleCreateProjectFromFolder: async () => {},
    selectProject: () => {},
    handleSelectProjectSession: async () => {},
    acceptProjectSlashCommand: () => {},
    acceptProjectMentionTarget: () => {},
    acceptChatSlashCommand: () => {},
    acceptChatMentionTarget: () => {},
    saveDesktopAttachments: async () => [],
    removeChatComposerAttachment: () => {},
    updateChatComposerDraft: () => {},
    updateProjectComposerDraft: () => {},
    toggleComposerSelector: () => {},
    selectComposerAuthChoice: async () => {},
    selectComposerProviderChoice: async () => {},
    setIsDetailPanelCollapsed: () => {},
    setActiveSourcePreview: () => {},
    ...overrides,
  };
}

test('sidebar shell forwards chat create and group management handlers', () => {
  const startPerson = async () => {};
  const startAgent = async () => {};
  const createGroup = async () => {};
  const renameGroup = async () => {};
  const addMembers = async () => {};
  const removeMember = async () => {};
  const setAdmin = async () => {};
  const element = assembleSidebarSlot(baseSidebarArgs({
    handleStartChatWithPerson: startPerson,
    handleStartChatWithAgent: startAgent,
    handleCreateChatGroup: createGroup,
    handleRenameChatGroup: renameGroup,
    handleAddChatGroupMembers: addMembers,
    handleRemoveChatGroupMember: removeMember,
    handleSetChatGroupAdmin: setAdmin,
  }) as never) as never as { props: Record<string, unknown> };

  assert.equal(element.props.onStartChatWithPerson, startPerson);
  assert.equal(element.props.onStartChatWithAgent, startAgent);
  assert.equal(element.props.onCreateChatGroup, createGroup);
  assert.equal(element.props.onRenameChatGroup, renameGroup);
  assert.equal(element.props.onAddChatGroupMembers, addMembers);
  assert.equal(element.props.onRemoveChatGroupMember, removeMember);
  assert.equal(element.props.onSetChatGroupAdmin, setAdmin);
});

test('contact Message starts a fresh person session instead of selecting an existing one', () => {
  const calls: string[] = [];
  const element = assembleMainContentSlot(baseShellArgs(calls) as never) as never as { props: { contactsPageProps: { onMessageContact: (contact: Record<string, unknown>) => void } } };

  element.props.contactsPageProps.onMessageContact({
    id: 'contact-bob',
    classType: 'other-users',
    bridgeHumanId: 'human-bob',
    bridgePeerNodeId: 'node-shared',
    bridgeHostId: 'host-1',
    name: 'Bob',
    owner: 'Bob',
    bridgePeerRuntime: 'person',
  });

  assert.deepEqual(calls, ['overlay:null', 'startPerson:host-1:node-shared:human-bob']);
});

test('agent Message switches to Chats before selecting an existing conversation', () => {
  const calls: string[] = [];
  const element = assembleMainContentSlot(baseShellArgs(calls, {
    chatConversations: [directAgentConversation()],
  }) as never) as never as { props: { agentsPageProps: { onMessageAgent: (agent: Record<string, unknown>) => void } } };

  element.props.agentsPageProps.onMessageAgent({
    id: 'agent-bob',
    isOwned: false,
    bridgeAgentId: 'agent-bob',
    bridgePeerNodeId: 'node-shared',
    bridgeHostId: 'host-1',
    name: 'Bob agent',
    bridgePeerRuntime: 'kordi-desktop',
  });

  assert.deepEqual(calls, ['nav:chats', 'select:session:bridge:agents:bob-agent']);
});

test('external agent contact Message prefers the agent conversation over a same-node person conversation', () => {
  const calls: string[] = [];
  const element = assembleMainContentSlot(baseShellArgs(calls, {
    chatConversations: [directPersonConversation(), directAgentConversation()],
  }) as never) as never as { props: { contactsPageProps: { onMessageContact: (contact: Record<string, unknown>) => void } } };

  element.props.contactsPageProps.onMessageContact({
    id: 'contact-bob-agent',
    classType: 'other-users-agents',
    bridgeHumanId: 'human-bob',
    bridgeAgentId: 'agent-bob',
    bridgePeerNodeId: 'node-shared',
    bridgeHostId: 'host-1',
    name: 'Bob agent',
    owner: 'Bob',
    bridgePeerRuntime: 'kordi-desktop',
  });

  assert.deepEqual(calls, ['overlay:null', 'nav:chats', 'select:session:bridge:agents:bob-agent']);
});

test('bridge Chat starts a fresh person session instead of selecting an existing one', () => {
  const calls: string[] = [];
  const props = buildBridgePageProps(baseShellArgs(calls, {
    activeNav: 'bridge',
    chatConversations: [directPersonConversation()],
  }) as never) as never as {
    onOpenBridgeConversation: (
      hostId: string,
      peerNodeId: string,
      peerDisplayName?: string | null,
      peerOwnerName?: string | null,
      peerRuntime?: string | null,
      target?: { humanId?: string | null; agentId?: string | null },
    ) => void;
  };

  props.onOpenBridgeConversation('host-1', 'node-shared', 'Bob', 'Bob', 'person', { humanId: 'human-bob' });

  assert.deepEqual(calls, ['startPerson:host-1:node-shared:human-bob']);
});

test('bridge Chat uses target identity before selecting an existing same-node agent conversation', () => {
  const calls: string[] = [];
  const props = buildBridgePageProps(baseShellArgs(calls, {
    activeNav: 'bridge',
    chatConversations: [directPersonConversation(), directAgentConversation()],
  }) as never) as never as {
    onOpenBridgeConversation: (
      hostId: string,
      peerNodeId: string,
      peerDisplayName?: string | null,
      peerOwnerName?: string | null,
      peerRuntime?: string | null,
      target?: { humanId?: string | null; agentId?: string | null },
    ) => void;
  };

  props.onOpenBridgeConversation('host-1', 'node-shared', 'Bob agent', 'Bob', 'kordi-desktop', { agentId: 'agent-bob' });

  assert.deepEqual(calls, ['nav:chats', 'select:session:bridge:agents:bob-agent']);
});

test('workspace view model exposes participant spaces alongside flat chat conversations', () => {
  let viewModels: ReturnType<typeof useWorkspaceViewModels> | null = null;
  function Probe() {
    viewModels = useWorkspaceViewModels({
      isNativeShell: false,
      isDesktopChatLoading: false,
      desktopChatState: null,
      desktopBridgeState: null,
      canonicalSessionState: null,
      hiddenSessionIds: new Set(),
      projectWorkspaces: [{
        id: 'project:test',
        name: 'Test project',
        summary: 'Fixture project',
        bridge: 'Local',
        scope: '/tmp/kordi-test',
        status: 'Local',
        people: [],
        agents: [],
        pendingInvites: [],
        artifacts: 0,
        tasks: 0,
        sessions: [],
      }],
      projectSelectedSessionIds: {},
      activeNav: 'chats',
      activeConvId: 'c1',
      activeProjectId: '',
      activeProjectSessionId: '',
      chatFilter: 'all',
      chatSearch: '',
      projectSearch: '',
      contactSearch: '',
      activeContactId: '',
      activeAgentId: '',
      cachedChatSessionMessages: {},
      cachedProjectSessionMessages: {},
      localSessionUnreadCounts: {},
      desktopLiveTurnsBySession: {},
      mapDesktopMessages: () => [],
    });
    return null;
  }

  renderToStaticMarkup(createElement(Probe));

  assert.ok(viewModels?.participantSpaces.length);
  assert.ok(viewModels?.participantSpaces[0]?.sessions.length);
  assert.equal(viewModels?.filteredParticipantSpaces.length, viewModels?.participantSpaces.length);
});

test('canonical read model keeps separate direct person bridge sessions for the same participant', () => {
  const readModel = createCanonicalSessionReadModel({
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Me',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: null,
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:bob', kind: 'human', displayName: 'Bob', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-shared', humanId: 'human-bob', avatarKey: 'human-bob', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: 'session:bridge:humans:first', kind: 'direct-person', title: 'first hello', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:bob', relationshipIdentityId: 'human:bob', metadata: { source: 'bridge-session-thread', bridgeHostId: 'host-1', peerNodeId: 'node-shared', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 1, lastMessageAtMs: 1 },
      { id: 'session:bridge:humans:second', kind: 'direct-person', title: 'second hello', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:bob', relationshipIdentityId: 'human:bob', metadata: { source: 'bridge-session-thread', bridgeHostId: 'host-1', peerNodeId: 'node-shared', peerRuntime: 'person' }, createdAtMs: 2, updatedAtMs: 2, lastMessageAtMs: 2 },
    ],
    participants: [
      { sessionId: 'session:bridge:humans:first', identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:bridge:humans:first', identityId: 'human:bob', role: 'delegate', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:bridge:humans:second', identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 2 },
      { sessionId: 'session:bridge:humans:second', identityId: 'human:bob', role: 'delegate', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 2 },
    ],
    messages: [],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  } as never);

  const conversations = readModel?.buildChatConversations([], (messages, fallback) => messages[0]?.text ?? fallback ?? '') ?? [];

  assert.deepEqual(conversations.map((conversation) => conversation.id), [
    'session:bridge:humans:second',
    'session:bridge:humans:first',
  ]);
});

test('canonical read model suppresses optimistic bridge UI echo after parent bridge sync confirms send', () => {
  const sessionId = 'session:bridge:humans:bob';
  const readModel = createCanonicalSessionReadModel({
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Me',
      humanIdentityId: 'human:profile:me',
      activeAgentIdentityId: null,
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:profile:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:bridge:me', kind: 'human', displayName: 'Me', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-me', humanId: 'human-me', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:bob', kind: 'human', displayName: 'Bob', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-bob', humanId: 'human-bob', avatarKey: 'bob', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'direct-person', title: 'Bob', status: 'active', createdByIdentityId: 'human:profile:me', primaryIdentityId: 'human:bob', relationshipIdentityId: 'human:bob', metadata: { source: 'bridge-session-thread', bridgeHostId: 'host-1', peerNodeId: 'node-bob', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 1_800, lastMessageAtMs: 1_800 },
    ],
    participants: [
      { sessionId, identityId: 'human:bridge:me', role: 'self', state: 'active', addedByIdentityId: 'human:profile:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:bob', role: 'delegate', state: 'active', addedByIdentityId: 'human:profile:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:ui', sessionId, senderIdentityId: 'human:profile:me', senderRole: 'user', messageKind: 'text', contentText: 'hi shu how are you', content: { sender: 'Me', timeLabel: '19:22' }, status: 'sent', sequenceNum: 1, createdAtMs: 1_000, updatedAtMs: 1_000, contentHash: null, sourceTransport: 'desktop-bridge-ui', sourceEventId: 'desktop-bridge-ui:session:bridge:humans:bob:1000' },
      { id: 'msg:parent', sessionId, senderIdentityId: 'human:bridge:me', senderRole: 'user', messageKind: 'text', contentText: 'hi shu how are you', content: { sender: 'Me', timeLabel: '19:22', deliveryState: 'read', bridgeConversationId: 'bridge:host-1:node-bob:person' }, status: 'read', sequenceNum: 2, createdAtMs: 1_800, updatedAtMs: 1_800, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'desktop-bridge-parent:session:bridge:humans:bob:bridge:host-1:node-bob:person:bridge_msg_1' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  } as never);

  assert.ok(readModel);

  const [conversation] = readModel.buildChatConversations([], (messages, fallback) => messages[0]?.text || fallback || '');

  assert.equal(conversation.messages.length, 1);
  assert.equal(conversation.messages[0]?.text, 'hi shu how are you');
  assert.deepEqual(conversation.messages[0]?.statusChips, ['read']);
});

test('canonical read model preserves unread count from source bridge conversation', () => {
  const readModel = createCanonicalSessionReadModel({
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Me',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: null,
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:bob', kind: 'human', displayName: 'Bob', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-bob', humanId: 'human-bob', avatarKey: 'bob', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: 'session:bridge:humans:unread', kind: 'direct-person', title: 'Bob', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:bob', relationshipIdentityId: 'human:bob', metadata: { source: 'bridge-session-thread', bridgeHostId: 'host-1', peerNodeId: 'node-bob', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 2, lastMessageAtMs: 2 },
    ],
    participants: [
      { sessionId: 'session:bridge:humans:unread', identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:bridge:humans:unread', identityId: 'human:bob', role: 'delegate', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg-1', sessionId: 'session:bridge:humans:unread', senderIdentityId: 'human:bob', senderRole: 'person', messageKind: 'text', contentText: 'Unread hello', content: { sender: 'Bob', timeLabel: '10:00' }, status: 'delivered', sequenceNum: 1, createdAtMs: 2, updatedAtMs: 2, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'unread-1' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  } as never);

  assert.ok(readModel);

  const sourceConversation = {
    id: 'bridge:host-1:node-bob:person',
    canonicalSessionId: 'session:bridge:humans:unread',
    name: 'Bob',
    type: 'person' as const,
    subtitle: 'Direct person chat',
    unread: 3,
    bridges: ['Bridge'],
    trust: 'Bridge',
    directness: 'Direct person chat',
    participants: ['Me', 'Bob'],
    messages: [{ role: 'person' as const, sender: 'Bob', text: 'Unread hello', time: '10:00' }],
  };

  const [conversation] = readModel.buildChatConversations([sourceConversation], (messages, fallback) => messages[0]?.text || fallback || '');

  assert.equal(conversation.unread, 3);
});

test('canonical read model preserves unread count when bridge source is routed by outreach parent session', () => {
  const latestSessionId = 'session:bridge:humans:latest';
  const olderSessionId = 'session:bridge:humans:older';
  const readModel = createCanonicalSessionReadModel({
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Me',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: null,
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:bob', kind: 'human', displayName: 'Bob', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-bob', humanId: 'human-bob', avatarKey: 'bob', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: latestSessionId, kind: 'direct-person', title: 'new unread', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:bob', relationshipIdentityId: 'human:bob', metadata: { source: 'bridge-session-thread', bridgeConversationId: 'bridge:host-1:node-bob:person', bridgeHostId: 'host-1', peerNodeId: 'node-bob', peerRuntime: 'person' }, createdAtMs: 2, updatedAtMs: 3, lastMessageAtMs: 3 },
      { id: olderSessionId, kind: 'direct-person', title: 'old thread', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:bob', relationshipIdentityId: 'human:bob', metadata: { source: 'bridge-session-thread', bridgeConversationId: 'bridge:host-1:node-bob:person', bridgeHostId: 'host-1', peerNodeId: 'node-bob', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 1, lastMessageAtMs: 1 },
    ],
    participants: [
      { sessionId: latestSessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: latestSessionId, identityId: 'human:bob', role: 'delegate', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: olderSessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: olderSessionId, identityId: 'human:bob', role: 'delegate', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg-latest', sessionId: latestSessionId, senderIdentityId: 'human:bob', senderRole: 'person', messageKind: 'text', contentText: 'new unread', content: { sender: 'Bob', timeLabel: '10:03' }, status: 'delivered', sequenceNum: 1, createdAtMs: 3, updatedAtMs: 3, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'latest-1' },
      { id: 'msg-older', sessionId: olderSessionId, senderIdentityId: 'human:bob', senderRole: 'person', messageKind: 'text', contentText: 'old thread', content: { sender: 'Bob', timeLabel: '10:01' }, status: 'delivered', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'older-1' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  } as never);

  assert.ok(readModel);

  const sourceConversation = {
    id: 'bridge:host-1:node-bob:person',
    canonicalSessionId: 'session:bridge:humans:stable-pair',
    name: 'Bob',
    type: 'person' as const,
    subtitle: 'Direct person chat',
    unread: 2,
    bridgeUnreadByParentSessionId: { [latestSessionId]: 1, [olderSessionId]: 1 },
    bridges: ['Bridge'],
    trust: 'Bridge',
    directness: 'Direct person chat',
    participants: ['Me', 'Bob'],
    messages: [{ role: 'person' as const, sender: 'Bob', text: 'new unread', time: '10:03' }],
    outreach: { parentSessionId: latestSessionId },
  };

  const conversations = readModel.buildChatConversations([sourceConversation as never], (messages, fallback) => messages[0]?.text || fallback || '');

  const latestConversation = conversations.find((conversation) => conversation.canonicalSessionId === latestSessionId);
  assert.equal(latestConversation?.id, latestSessionId);
  assert.equal(latestConversation?.unread, 1);
  assert.equal(conversations.find((conversation) => conversation.canonicalSessionId === olderSessionId)?.unread, 1);
  assert.equal(conversations.some((conversation) => conversation.id === 'bridge:host-1:node-bob:person'), false);
});

test('workspace view model hydrates hidden bridge outreach unread into its canonical session', () => {
  const sessionId = 'session:bridge:humans:hidden-unread';
  const olderSessionId = 'session:bridge:humans:older-hidden-unread';
  const bridgeConversationId = 'bridge:host-1:node-bob:person';
  const bridgeConversation = {
    id: bridgeConversationId,
    canonicalSessionId: 'session:bridge:humans:stable-pair',
    hostId: 'host-1',
    peerNodeId: 'node-bob',
    peerDisplayName: 'Bob',
    peerOwnerName: 'Bob',
    peerRuntime: 'person',
    projectId: null,
    projectName: null,
    title: 'Hi shu',
    subtitle: 'Hi shu',
    unreadCount: 2,
    updatedAtMs: 3,
    updatedAtLabel: '16:07',
    awaitingReply: false,
    peerTyping: false,
    peerLastHeartbeatLabel: null,
    outreach: {
      targetKind: 'bridge-person',
      parentSessionId: sessionId,
      bridgeHostId: 'host-1',
      bridgeConversationId,
      bridgeRequestId: 'bridge_req_hidden',
      targetNodeId: 'node-bob',
      targetDisplayName: 'Bob',
      requestText: 'Hi shu',
      status: 'completed',
      createdAtMs: 3,
      updatedAtMs: 3,
    },
    identity: null,
    messages: [{
      id: 'bridge-msg-older-hidden',
      direction: 'inbound',
      sender: 'Bob',
      text: 'Earlier unread',
      timeLabel: '16:03',
      timestampMs: 2,
      requestId: 'bridge_req_older_hidden',
      deliveryState: null,
      outreach: {
        targetKind: 'bridge-person',
        parentSessionId: olderSessionId,
        bridgeHostId: 'host-1',
        bridgeConversationId,
        bridgeRequestId: 'bridge_req_older_hidden',
        targetNodeId: 'node-bob',
        targetDisplayName: 'Bob',
        requestText: 'Earlier unread',
        status: 'completed',
        createdAtMs: 2,
        updatedAtMs: 2,
      },
    }, {
      id: 'bridge-msg-hidden',
      direction: 'inbound',
      sender: 'Bob',
      text: 'Hi shu',
      timeLabel: '16:07',
      timestampMs: 3,
      requestId: 'bridge_req_hidden',
      deliveryState: null,
      outreach: {
        targetKind: 'bridge-person',
        parentSessionId: sessionId,
        bridgeHostId: 'host-1',
        bridgeConversationId,
        bridgeRequestId: 'bridge_req_hidden',
        targetNodeId: 'node-bob',
        targetDisplayName: 'Bob',
        requestText: 'Hi shu',
        status: 'completed',
        createdAtMs: 3,
        updatedAtMs: 3,
      },
    }],
  };
  const canonicalState = {
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Me',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: null,
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:bob', kind: 'human', displayName: 'Bob', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-bob', humanId: 'human-bob', avatarKey: 'bob', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'direct-person', title: 'Hi shu', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:bob', relationshipIdentityId: 'human:bob', metadata: { source: 'bridge-session-thread', bridgeConversationId, bridgeHostId: 'host-1', peerNodeId: 'node-bob', peerRuntime: 'person' }, createdAtMs: 2, updatedAtMs: 3, lastMessageAtMs: 3 },
      { id: olderSessionId, kind: 'direct-person', title: 'Earlier unread', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:bob', relationshipIdentityId: 'human:bob', metadata: { source: 'bridge-session-thread', bridgeConversationId, bridgeHostId: 'host-1', peerNodeId: 'node-bob', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 2, lastMessageAtMs: 2 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:bob', role: 'delegate', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: olderSessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: olderSessionId, identityId: 'human:bob', role: 'delegate', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg-hidden', sessionId, senderIdentityId: 'human:bob', senderRole: 'person', messageKind: 'text', contentText: 'Hi shu', content: { sender: 'Bob', timeLabel: '16:07' }, status: 'delivered', sequenceNum: 1, createdAtMs: 3, updatedAtMs: 3, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'hidden-1' },
      { id: 'msg-older-hidden', sessionId: olderSessionId, senderIdentityId: 'human:bob', senderRole: 'person', messageKind: 'text', contentText: 'Earlier unread', content: { sender: 'Bob', timeLabel: '16:03' }, status: 'delivered', sequenceNum: 1, createdAtMs: 2, updatedAtMs: 2, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'older-hidden-1' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };
  let viewModels: ReturnType<typeof useWorkspaceViewModels> | null = null;
  function Probe() {
    viewModels = useWorkspaceViewModels({
      isNativeShell: true,
      isDesktopChatLoading: false,
      desktopChatState: null,
      desktopBridgeState: {
        configPath: '/tmp/bridge.json',
        legacyConfigPath: '/tmp/legacy.json',
        conversationsPath: '/tmp/conversations.sqlite3',
        activeHostId: 'host-1',
        hosts: [{
          id: 'host-1',
          registered: true,
          connected: true,
          serverUrl: 'https://bridge.test',
          nodeId: 'node-me',
          displayName: 'Me',
          ownerName: 'Me',
          endpoint: 'https://bridge.test',
          tokenPresent: true,
          humanId: 'human-me',
          discoveryMode: 'ask',
          activeAgentId: null,
          agents: [],
          visiblePeers: [],
          visiblePeerCount: 0,
          projects: [],
        }],
        conversations: [bridgeConversation],
        localServer: { running: true },
      } as never,
      canonicalSessionState: canonicalState as never,
      hiddenSessionIds: new Set(),
      projectWorkspaces: [],
      projectSelectedSessionIds: {},
      activeNav: 'chats',
      activeConvId: 'draft:local-chat',
      activeProjectId: '',
      activeProjectSessionId: 'draft:project-chat',
      chatFilter: 'all',
      chatSearch: '',
      projectSearch: '',
      contactSearch: '',
      activeContactId: '',
      activeAgentId: '',
      cachedChatSessionMessages: {},
      cachedProjectSessionMessages: {},
      localSessionUnreadCounts: {},
      desktopLiveTurnsBySession: {},
      mapDesktopMessages: () => [],
    });
    return null;
  }

  renderToStaticMarkup(createElement(Probe));

  const sessionConversation = viewModels?.chatConversations.find((conversation) => conversation.canonicalSessionId === sessionId);
  assert.equal(sessionConversation?.id, sessionId);
  assert.equal(sessionConversation?.unread, 1);
  assert.equal(viewModels?.chatConversations.find((conversation) => conversation.canonicalSessionId === olderSessionId)?.unread, 1);
  assert.equal(viewModels?.chatConversations.some((conversation) => conversation.id === bridgeConversationId), false);
});

test('canonical read model keeps shared bridge transcript with local owned-agent tool details', () => {
  const sessionId = 'session:bridge:humans:shared';
  const canonicalState = {
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Me',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: 'agent:local',
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:bob', kind: 'human', displayName: 'Bob', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-shared', humanId: 'human-bob', avatarKey: 'human-bob', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:local', kind: 'agent', displayName: 'Kordi', source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent-local', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'direct-person', title: 'stale later reply', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:bob', relationshipIdentityId: 'human:bob', metadata: { source: 'bridge-session-thread', bridgeHostId: 'host-1', peerNodeId: 'node-shared', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 2, lastMessageAtMs: 2 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:bob', role: 'delegate', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:shared:1', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'hi bob', content: { sender: 'Me', timeLabel: '13:27' }, status: 'sent', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'shared-1' },
      { id: 'msg:shared:2', sessionId, senderIdentityId: 'human:bob', senderRole: 'person', messageKind: 'text', contentText: 'hello', content: { sender: 'Bob', timeLabel: '13:28' }, status: 'sent', sequenceNum: 2, createdAtMs: 2, updatedAtMs: 2, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'shared-2' },
      { id: 'msg:shared:3', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'done', content: { sender: 'Kordi', timeLabel: '13:29' }, status: 'sent', sequenceNum: 3, createdAtMs: 3, updatedAtMs: 3, contentHash: null, sourceTransport: 'desktop-bridge-session-relay', sourceEventId: 'shared-3' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };
  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const localRuntimeConversation = {
    id: sessionId,
    canonicalSessionId: sessionId,
    name: 'hi bob',
    type: 'owned-agent',
    subtitle: '',
    unread: 0,
    bridges: ['Local'],
    trust: 'Owned',
    directness: 'Direct chat',
    participants: ['Me', 'Kordi'],
    messages: [{
      role: 'owned-agent',
      sender: 'Kordi',
      text: 'done',
      time: '13:29',
      turn: {
        id: 'local-turn-1',
        sessionId,
        prompt: 'run local tool',
        status: 'succeeded',
        message: 'Response complete',
        assistantText: 'done',
        thinkingText: 'local thinking',
        tools: [{ name: 'read' }],
        completed: true,
        succeeded: true,
        error: null,
      },
    }],
  };

  const conversations = readModel?.buildChatConversations([localRuntimeConversation as never], (messages, fallback) => messages[0]?.text ?? fallback ?? '') ?? [];

  assert.equal(conversations[0]?.name, 'hi bob');
  assert.deepEqual(conversations[0]?.messages.map((message) => message.text || message.turn?.assistantText), ['hi bob', 'hello', 'done']);
  assert.deepEqual(conversations[0]?.messages[2]?.turn?.tools.map((tool: { name: string }) => tool.name), ['read']);
});

test('canonical read model keeps shared relationship history when local runtime has richer tool details', () => {
  const sessionId = '91ecedce-0766-4d34-9b4f-feb572321b22';
  const canonicalState = {
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Me',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: 'agent:local',
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:shenzhe', kind: 'human', displayName: 'Shenzhe', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-shenzhe', humanId: 'human-shenzhe', avatarKey: 'human-shenzhe', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:local', kind: 'agent', displayName: 'Kordi', source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent-local', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'relationship', title: 'check the core agent loop', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:shenzhe', relationshipIdentityId: 'human:shenzhe', metadata: { source: 'bridge-session-thread', bridgeHostId: 'host-1', peerNodeId: 'node-shenzhe', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 4, lastMessageAtMs: 4 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:shenzhe', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:local', role: 'owned-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:history:1', sessionId, senderIdentityId: 'human:shenzhe', senderRole: 'person', messageKind: 'text', contentText: 'check the core agent loop of https://github.com/openai/codex', content: { sender: 'Shenzhe', timeLabel: '20:15' }, status: 'complete', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1, contentHash: null, sourceTransport: 'desktop-bridge-thread-snapshot', sourceEventId: 'history-1' },
      { id: 'msg:history:2', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'The core loop is in session handlers.', content: { sender: 'My Kordi', timeLabel: '20:15' }, status: 'complete', sequenceNum: 2, createdAtMs: 2, updatedAtMs: 2, contentHash: null, sourceTransport: 'desktop-bridge-thread-snapshot', sourceEventId: 'history-2' },
      { id: 'msg:translate:1', sessionId, senderIdentityId: 'human:shenzhe', senderRole: 'user', messageKind: 'text', contentText: '@MyKordi can you translate it to chinese', content: { sender: 'Shenzhe', timeLabel: '20:16' }, status: 'sent', sequenceNum: 3, createdAtMs: 3, updatedAtMs: 3, contentHash: null, sourceTransport: 'desktop-chat-ui', sourceEventId: 'translate-1' },
      { id: 'msg:translate:2', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: '当然，翻译如下。', content: { sender: 'My Kordi', timeLabel: '20:16' }, status: 'complete', sequenceNum: 4, createdAtMs: 4, updatedAtMs: 4, contentHash: null, sourceTransport: 'desktop-bridge-session-relay', sourceEventId: 'translate-2' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };
  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const localRuntimeConversation = {
    id: sessionId,
    canonicalSessionId: sessionId,
    name: '@Kordi can you translate it to chinese',
    type: 'owned-agent',
    subtitle: '',
    unread: 1,
    bridges: ['Local'],
    trust: 'Owned',
    directness: 'Direct chat',
    participants: ['Me', 'Kordi'],
    bridgeTarget: { hostId: 'host-1', nodeId: 'node-shenzhe', displayName: 'Shenzhe', ownerName: 'Shenzhe', runtime: 'person', humanId: 'human-shenzhe', agentId: null },
    messages: [{
      role: 'owned-agent',
      sender: 'My Kordi',
      text: '当然，翻译如下。',
      time: '20:16',
      turn: {
        id: 'local-turn-translate',
        sessionId,
        prompt: 'translate it',
        status: 'succeeded',
        message: 'Response complete',
        assistantText: '当然，翻译如下。',
        thinkingText: '',
        tools: [{ name: 'web_search' }],
        completed: true,
        succeeded: true,
        error: null,
      },
    }],
  };

  const conversations = readModel?.buildChatConversations([localRuntimeConversation as never], (messages, fallback) => messages[0]?.text ?? fallback ?? '') ?? [];

  assert.deepEqual(
    conversations[0]?.messages.map((message) => message.text || message.turn?.assistantText),
    [
      'check the core agent loop of https://github.com/openai/codex',
      'The core loop is in session handlers.',
      '@MyKordi can you translate it to chinese',
      '当然，翻译如下。',
    ],
  );
  assert.deepEqual(conversations[0]?.messages[3]?.turn?.tools.map((tool: { name: string }) => tool.name), ['web_search']);
});

test('canonical read model prefers local rich owned-agent runtime over later plain bridge relay duplicate', () => {
  const sessionId = 'session:bridge:humans:rich-local-runtime';
  const canonicalState = {
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Me',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: 'agent:local',
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:shenzhe', kind: 'human', displayName: 'Shenzhe', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-shenzhe', humanId: 'human-shenzhe', avatarKey: 'human-shenzhe', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:local', kind: 'agent', displayName: 'Kordi', source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent-local', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'direct-person', title: 'inspect repo', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:shenzhe', relationshipIdentityId: 'human:shenzhe', metadata: { source: 'bridge-session-thread', bridgeHostId: 'host-1', peerNodeId: 'node-shenzhe', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 3, lastMessageAtMs: 3 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:shenzhe', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:local', role: 'owned-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:request', sessionId, senderIdentityId: 'human:shenzhe', senderRole: 'person', messageKind: 'text', contentText: 'inspect repo', content: { sender: 'Shenzhe', timeLabel: '20:15' }, status: 'sent', sequenceNum: 1, createdAtMs: 1_000, updatedAtMs: 1_000, contentHash: null, sourceTransport: 'desktop-bridge-session-relay', sourceEventId: 'request' },
      { id: 'msg:local-rich', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'The repo core loop is in session handlers.', content: { sender: 'My Kordi', timeLabel: '20:16', thinkingText: 'local chain', tools: [{ id: 'tool-1', name: 'read', status: 'complete', arguments: '', liveOutput: '', resultText: 'src/main.rs', detail: null, isError: false }] }, status: 'complete', sequenceNum: 2, createdAtMs: 2_000, updatedAtMs: 2_000, contentHash: null, sourceTransport: 'desktop-chat', sourceEventId: 'local-rich' },
      { id: 'msg:relay-plain', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'The repo core loop is in session handlers.', content: { sender: 'My Kordi', timeLabel: '20:16', kind: 'session-relay' }, status: 'complete', sequenceNum: 3, createdAtMs: 2_100, updatedAtMs: 2_100, contentHash: null, sourceTransport: 'desktop-bridge-session-relay', sourceEventId: 'relay-plain' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const messages = readModel.messages(sessionId);

  assert.deepEqual(messages.map((message) => message.text || message.turn?.assistantText), [
    'inspect repo',
    'The repo core loop is in session handlers.',
  ]);
  assert.equal(messages[1]?.turn?.thinkingText, 'local chain');
  assert.deepEqual(messages[1]?.turn?.tools.map((tool: { name: string }) => tool.name), ['read']);
});

test('canonical read model dedupes owned-agent runtime and bridge relay when only whitespace differs', () => {
  const sessionId = 'session:bridge:humans:whitespace-duplicate-runtime';
  const localText = 'I’ll check current web weather info for Thuwal today and summarize it.\n\nToday in **Thuwal, Saudi Arabia**:\n\n- **Current temperature:** about **29°C**';
  const relayText = 'I’ll check current web weather info for Thuwal today and summarize it.Today in **Thuwal, Saudi Arabia**:\n\n- **Current temperature:** about **29°C**';
  const canonicalState = {
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Me',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: 'agent:local',
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:peer', kind: 'human', displayName: 'Peer', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-peer', humanId: 'human-peer', avatarKey: 'human-peer', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:local', kind: 'agent', displayName: 'My Kordi', source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent-local', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'direct-person', title: 'Peer', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:peer', relationshipIdentityId: 'human:peer', metadata: { source: 'bridge-session-thread', bridgeHostId: 'host-1', peerNodeId: 'node-peer', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 3, lastMessageAtMs: 3 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:peer', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:local', role: 'owned-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:request', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: '@MyKordi can you check thuwal weather today?', content: { sender: 'Me', timeLabel: '13:36' }, status: 'sent', sequenceNum: 1, createdAtMs: 1_000, updatedAtMs: 1_000, contentHash: null, sourceTransport: 'desktop-chat-ui', sourceEventId: 'request' },
      { id: 'msg:local-rich', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: localText, content: { sender: 'My Kordi', timeLabel: '13:37', thinkingText: 'local chain', tools: [{ id: 'tool-1', name: 'web_fetch', status: 'complete', arguments: '', liveOutput: '', resultText: 'weather', detail: null, isError: false }] }, status: 'complete', sequenceNum: 2, createdAtMs: 2_000, updatedAtMs: 2_000, contentHash: null, sourceTransport: 'desktop-chat', sourceEventId: 'local-rich' },
      { id: 'msg:relay-plain', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: relayText, content: { sender: 'My Kordi', timeLabel: '13:37', kind: 'session-relay' }, status: 'complete', sequenceNum: 3, createdAtMs: 2_100, updatedAtMs: 2_100, contentHash: null, sourceTransport: 'desktop-bridge-session-relay', sourceEventId: 'relay-plain' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const messages = readModel.messages(sessionId);

  assert.deepEqual(messages.map((message) => message.text || message.turn?.assistantText), [
    '@MyKordi can you check thuwal weather today?',
    localText,
  ]);
  assert.deepEqual(messages[1]?.turn?.tools.map((tool: { name: string }) => tool.name), ['web_fetch']);
});

test('canonical read model dedupes plain local owned-agent runtime and bridge relay duplicates', () => {
  const sessionId = 'session:bridge:humans:plain-duplicate-runtime';
  const responseText = 'The page is a Google Scholar profile for Shu Yang.';
  const canonicalState = {
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Me',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: 'agent:local',
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:peer', kind: 'human', displayName: 'Peer', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-peer', humanId: 'human-peer', avatarKey: 'human-peer', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:local', kind: 'agent', displayName: 'My Kordi', source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent-local', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'direct-person', title: 'Peer', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:peer', relationshipIdentityId: 'human:peer', metadata: { source: 'bridge-session-thread', bridgeHostId: 'host-1', peerNodeId: 'node-peer', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 3, lastMessageAtMs: 3 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:peer', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:local', role: 'owned-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:request', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: '@MyKordi check scholar', content: { sender: 'Me', timeLabel: '19:28' }, status: 'sent', sequenceNum: 1, createdAtMs: 1_000, updatedAtMs: 1_000, contentHash: null, sourceTransport: 'desktop-chat-ui', sourceEventId: 'request' },
      { id: 'msg:local-plain', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: responseText, content: { sender: 'My Kordi', timeLabel: '19:29', thinkingText: '', tools: [] }, status: 'complete', sequenceNum: 2, createdAtMs: 2_000, updatedAtMs: 2_000, contentHash: null, sourceTransport: 'desktop-chat', sourceEventId: 'local-plain' },
      { id: 'msg:relay-plain', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: responseText, content: { sender: 'My Kordi', timeLabel: '19:29', kind: 'session-relay' }, status: 'complete', sequenceNum: 3, createdAtMs: 2_100, updatedAtMs: 2_100, contentHash: null, sourceTransport: 'desktop-bridge-session-relay', sourceEventId: 'relay-plain' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const messages = readModel.messages(sessionId);

  assert.deepEqual(messages.map((message) => message.text || message.turn?.assistantText), [
    '@MyKordi check scholar',
    responseText,
  ]);
  assert.equal(messages[1]?.turn?.id, 'canonical-turn:msg:local-plain');
});

test('canonical read model hides stale bridge processing placeholders after later agent response', () => {
  const sessionId = 'session:bridge:humans:stale-processing';
  const finalText = 'I checked the Scholar page and summarized the visible profile.';
  const canonicalState = {
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Me',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: 'agent:local',
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:peer', kind: 'human', displayName: 'Peer', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-peer', humanId: 'human-peer', avatarKey: 'human-peer', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:local', kind: 'agent', displayName: 'My Kordi', source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent-local', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'direct-person', title: 'Peer', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:peer', relationshipIdentityId: 'human:peer', metadata: { source: 'bridge-session-thread', bridgeHostId: 'host-1', peerNodeId: 'node-peer', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 3, lastMessageAtMs: 3 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:peer', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:local', role: 'owned-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:request', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: '@MyKordi check scholar', content: { sender: 'Me', timeLabel: '19:28' }, status: 'sent', sequenceNum: 1, createdAtMs: 1_000, updatedAtMs: 1_000, contentHash: null, sourceTransport: 'desktop-chat-ui', sourceEventId: 'request' },
      { id: 'msg:processing', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'processing...', content: { sender: 'My Kordi', timeLabel: '19:28', kind: 'session-relay', deliveryState: 'read', requestId: 'bridge_req_processing' }, status: 'read', sequenceNum: 2, createdAtMs: 2_000, updatedAtMs: 2_000, contentHash: null, sourceTransport: 'desktop-bridge-session-relay', sourceEventId: 'processing' },
      { id: 'msg:final', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: finalText, content: { sender: 'My Kordi', timeLabel: '19:29', kind: 'session-relay', deliveryState: 'responded', requestId: 'bridge_req_final' }, status: 'complete', sequenceNum: 3, createdAtMs: 10_000, updatedAtMs: 10_000, contentHash: null, sourceTransport: 'desktop-bridge-session-relay', sourceEventId: 'final' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const messages = readModel.messages(sessionId);

  assert.deepEqual(messages.map((message) => message.text || message.turn?.assistantText), [
    '@MyKordi check scholar',
    finalText,
  ]);
});

test('activity marks bridge-backed chat sessions as visible local sessions for unread clearing', () => {
  assert.equal(visibleLocalSessionIdForActivity({
    activeNav: 'chats',
    activeChatSessionId: '91ecedce-0766-4d34-9b4f-feb572321b22',
    activeProjectSessionId: '',
  }), '91ecedce-0766-4d34-9b4f-feb572321b22');
  assert.equal(visibleLocalSessionIdForActivity({
    activeNav: 'chats',
    activeChatSessionId: 'session:bridge:humans:peer',
    activeProjectSessionId: '',
  }), 'session:bridge:humans:peer');
  assert.equal(visibleLocalSessionIdForActivity({
    activeNav: 'chats',
    activeChatSessionId: 'bridge:host:peer:person',
    activeChatCanonicalSessionId: 'session:bridge:humans:peer',
    activeProjectSessionId: '',
  }), 'session:bridge:humans:peer');
  assert.equal(visibleLocalSessionIdForActivity({
    activeNav: 'chats',
    activeChatSessionId: 'bridge:host:peer:person',
    activeProjectSessionId: '',
  }), null);
});

test('canonical read model keeps bridge unread when a local runtime source shares the same session', () => {
  const sessionId = 'session:bridge:humans:shared-unread';
  const canonicalState = {
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Me',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: 'agent:local',
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:peer', kind: 'human', displayName: 'Peer', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-peer', humanId: 'human-peer', avatarKey: 'human-peer', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:local', kind: 'agent', displayName: 'My Kordi', source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent-local', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'direct-person', title: 'Peer', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:peer', relationshipIdentityId: 'human:peer', metadata: { source: 'bridge-session-thread', bridgeHostId: 'host-1', peerNodeId: 'node-peer', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 3, lastMessageAtMs: 3 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:peer', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:local', role: 'owned-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg-peer', sessionId, senderIdentityId: 'human:peer', senderRole: 'person', messageKind: 'text', contentText: 'new unread from bridge', content: { sender: 'Peer', timeLabel: '13:11' }, status: 'sent', sequenceNum: 1, createdAtMs: 3, updatedAtMs: 3, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'peer-1' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };
  const bridgeSource = {
    id: 'bridge:host-1:node-peer:person',
    canonicalSessionId: sessionId,
    name: 'Peer',
    type: 'person',
    subtitle: 'new unread from bridge',
    unread: 1,
    bridgeUnreadByParentSessionId: { [sessionId]: 1 },
    bridges: ['Bridge'],
    trust: 'Bridge',
    directness: 'Direct person chat',
    participants: ['Me', 'Peer'],
    messages: [{ role: 'person', sender: 'Peer', senderType: 'human', text: 'new unread from bridge', time: '13:11' }],
  };
  const localRuntimeSource = {
    id: sessionId,
    canonicalSessionId: sessionId,
    name: 'Peer',
    type: 'owned-agent',
    subtitle: 'local runtime detail',
    unread: 0,
    bridges: ['Local'],
    trust: 'Owned',
    directness: 'Direct chat',
    participants: ['Me', 'My Kordi'],
    bridgeTarget: { hostId: 'host-1', nodeId: 'node-peer', displayName: 'Peer', ownerName: 'Peer', runtime: 'person' },
    messages: [{ role: 'owned-agent', sender: 'My Kordi', text: 'local tool-rich result', time: '13:10' }],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const conversations = readModel?.buildChatConversations([bridgeSource as never, localRuntimeSource as never], (messages, fallback) => messages[0]?.text ?? fallback ?? '') ?? [];

  assert.equal(conversations[0]?.unread, 1);
});

test('canonical read model keeps canonical parent transcript when bridge source misses an agent response', () => {
  const sessionId = 'session:bridge:humans:flapping-parent';
  const canonicalState = {
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Me',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: 'agent:local',
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:shenzhe', kind: 'human', displayName: 'Shenzhe', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-shenzhe', humanId: 'human-shenzhe', avatarKey: 'human-shenzhe', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:shenzhe', kind: 'agent', displayName: "Shenzhe's Kordi", source: 'bridge', ownerIdentityId: 'human:shenzhe', sourceHostId: 'host-1', bridgeNodeId: 'node-shenzhe', agentId: 'agent-shenzhe', avatarKey: 'agent-shenzhe', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'relationship', title: 'check todays weather', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:shenzhe', relationshipIdentityId: 'human:shenzhe', metadata: { source: 'bridge-session-thread', bridgeHostId: 'host-1', peerNodeId: 'node-shenzhe', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 5, lastMessageAtMs: 5 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:shenzhe', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:shenzhe', role: 'external-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:request', sessionId, senderIdentityId: 'human:shenzhe', senderRole: 'person', messageKind: 'text', contentText: '@MyKordi show me the diskusage', content: { sender: 'Shenzhe', timeLabel: '17:30', kind: 'session-relay' }, status: 'sent', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1, contentHash: null, sourceTransport: 'desktop-bridge-session-relay', sourceEventId: 'request' },
      { id: 'msg:response', sessionId, senderIdentityId: 'agent:shenzhe', senderRole: 'external-agent', messageKind: 'agent-turn', contentText: 'I tried to check disk usage with `df -h`.', content: { sender: "Shenzhe's Kordi", timeLabel: '17:30', kind: 'session-relay' }, status: 'complete', sequenceNum: 2, createdAtMs: 2, updatedAtMs: 2, contentHash: null, sourceTransport: 'desktop-bridge-session-relay', sourceEventId: 'response' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };
  const bridgeSourceMissingResponse = {
    id: 'bridge:host-1:node-shenzhe:person',
    canonicalSessionId: 'session:bridge:humans:stable-direct-thread',
    name: 'Shenzhe',
    type: 'person',
    subtitle: 'latest direct person source',
    unread: 0,
    bridges: ['Bridge'],
    trust: 'Bridge',
    directness: 'Person outreach',
    participants: ['Me', 'Shenzhe'],
    outreach: { parentSessionId: sessionId },
    messages: [
      { role: 'person', sender: 'Shenzhe', senderType: 'human', text: 'older raw bridge message', time: '17:28' },
      { role: 'person', sender: 'Shenzhe', senderType: 'human', text: '@ShenzhesKordi what is the weather today?', time: '17:29' },
      { role: 'person', sender: 'Shenzhe', senderType: 'human', text: '@MyKordi show me the diskusage', time: '17:30' },
    ],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const conversations = readModel?.buildChatConversations([bridgeSourceMissingResponse as never], (messages, fallback) => messages[0]?.text ?? fallback ?? '') ?? [];

  assert.deepEqual(
    conversations[0]?.messages.map((message) => message.text || message.turn?.assistantText),
    ['@ShenzhesKordi show me the diskusage', 'I tried to check disk usage with `df -h`.'],
  );
});

test('canonical read model rewrites remote first-person agent mention labels', () => {
  const sessionId = 'session:bridge:humans:remote-local-agent-label';
  const canonicalState = {
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Me',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: 'agent:local',
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:shenzhe', kind: 'human', displayName: 'Shenzhe', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-shenzhe', humanId: 'human-shenzhe', avatarKey: 'human-shenzhe', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'direct-person', title: 'show me the diskusage', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:shenzhe', relationshipIdentityId: 'human:shenzhe', metadata: { source: 'bridge-session-thread', bridgeHostId: 'host-1', peerNodeId: 'node-shenzhe', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 1, lastMessageAtMs: 1 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:shenzhe', role: 'delegate', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:remote-mention', sessionId, senderIdentityId: 'human:shenzhe', senderRole: 'person', messageKind: 'text', contentText: '@MyKordi  show me the diskusage', content: { sender: 'Shenzhe', timeLabel: '17:30', kind: 'session-relay' }, status: 'sent', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1, contentHash: null, sourceTransport: 'desktop-bridge-session-relay', sourceEventId: 'remote-mention-1' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const conversations = readModel?.buildChatConversations([], (messages, fallback) => messages[0]?.text ?? fallback ?? '') ?? [];

  assert.equal(conversations[0]?.messages[0]?.text, '@ShenzhesKordi show me the diskusage');
});

test('canonical read model suppresses local agent runtime user echo after bridge UI mention', () => {
  const sessionId = 'session:bridge:humans:shared-local-agent';
  const canonicalState = {
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Me',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: 'agent:local',
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:bob', kind: 'human', displayName: 'Bob', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-bob', humanId: 'human-bob', avatarKey: 'human-bob', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:local', kind: 'agent', displayName: 'Kordi', source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent-local', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'direct-person', title: 'show me the diskusage', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:bob', relationshipIdentityId: 'human:bob', metadata: { source: 'bridge-session-thread', bridgeHostId: 'host-1', peerNodeId: 'node-bob', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 3, lastMessageAtMs: 3 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:bob', role: 'delegate', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:ui', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: '@MyKordi  show me the diskusage', content: { sender: 'Me', timeLabel: '17:30' }, status: 'sent', sequenceNum: 1, createdAtMs: 1_000, updatedAtMs: 1_000, contentHash: null, sourceTransport: 'desktop-chat-ui', sourceEventId: 'desktop-chat-ui:shared-local-agent:1000' },
      { id: 'msg:runtime-user', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: '@Kordi  show me the diskusage', content: { sender: 'You', timeLabel: '17:30' }, status: 'sent', sequenceNum: 2, createdAtMs: 1_023, updatedAtMs: 1_023, contentHash: null, sourceTransport: 'desktop-chat', sourceEventId: 'desktop-chat:shared-local-agent:2:1023:user:hash' },
      { id: 'msg:agent', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'disk usage result', content: { sender: 'Kordi', timeLabel: '17:30' }, status: 'sent', sequenceNum: 3, createdAtMs: 2_000, updatedAtMs: 2_000, contentHash: null, sourceTransport: 'desktop-chat', sourceEventId: 'desktop-chat:shared-local-agent:3:assistant:turn' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const conversations = readModel?.buildChatConversations([], (messages, fallback) => messages[0]?.text ?? fallback ?? '') ?? [];

  assert.deepEqual(
    conversations[0]?.messages.map((message) => message.text || message.turn?.assistantText),
    ['@MyKordi  show me the diskusage', 'disk usage result'],
  );
});

test('canonical read model strips remote external-agent tool details from canonical messages', () => {
  const sessionId = 'session:bridge:humans:remote-tools';
  const canonicalState = {
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Me',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: 'agent:local',
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:bob', kind: 'human', displayName: 'Bob', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-shared', humanId: 'human-bob', avatarKey: 'human-bob', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:bob', kind: 'agent', displayName: 'Bob Kordi', source: 'bridge', ownerIdentityId: 'human:bob', sourceHostId: 'host-1', bridgeNodeId: 'node-shared', agentId: 'agent-bob', avatarKey: 'agent-bob', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'direct-person', title: 'hi bob', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:bob', relationshipIdentityId: 'human:bob', metadata: { source: 'bridge-session-thread', bridgeHostId: 'host-1', peerNodeId: 'node-shared', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 2, lastMessageAtMs: 2 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:bob', role: 'delegate', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:remote-agent', sessionId, senderIdentityId: 'agent:bob', senderRole: 'external-agent', messageKind: 'agent-turn', contentText: 'remote answer', content: { sender: 'Bob Kordi', timeLabel: '13:30', thinkingText: 'remote private thinking', tools: [{ name: 'read', input: '{}', output: 'secret' }] }, status: 'sent', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1, contentHash: null, sourceTransport: 'desktop-bridge-session-relay', sourceEventId: 'remote-agent-1' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };
  const readModel = createCanonicalSessionReadModel(canonicalState as never);

  const conversations = readModel?.buildChatConversations([], (messages, fallback) => messages[0]?.text ?? fallback ?? '') ?? [];

  assert.equal(conversations[0]?.messages[0]?.turn?.assistantText, 'remote answer');
  assert.equal(conversations[0]?.messages[0]?.turn?.thinkingText, '');
  assert.deepEqual(conversations[0]?.messages[0]?.turn?.tools, []);
});

test('canonical read model does not override bridge agent runtime details with canonical messages', () => {
  const sessionId = 'session:bridge:agents:shared-agent';
  const canonicalState = {
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Me',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: 'agent:local',
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:bob', kind: 'agent', displayName: 'Bob agent', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-agent', agentId: 'agent-bob', avatarKey: 'agent-bob', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'direct-agent', title: 'Bob agent', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'agent:bob', relationshipIdentityId: null, metadata: { source: 'desktop-bridge-conversation', bridgeHostId: 'host-1', peerNodeId: 'node-agent', peerRuntime: 'kordi-desktop' }, createdAtMs: 1, updatedAtMs: 2, lastMessageAtMs: 2 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:bob', role: 'delegate', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:stale', sessionId, senderIdentityId: 'agent:bob', senderRole: 'external-agent', messageKind: 'agent-turn', contentText: 'stale canonical answer', content: { sender: 'Bob agent', timeLabel: '13:28' }, status: 'sent', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1, contentHash: null, sourceTransport: 'desktop-bridge', sourceEventId: 'agent-1' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };
  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const runtimeConversation = {
    id: sessionId,
    canonicalSessionId: sessionId,
    name: 'Bob agent',
    type: 'external-agent',
    subtitle: '',
    unread: 0,
    bridges: ['Bridge'],
    trust: 'Bridge',
    directness: 'Agent thread',
    participants: ['Me', 'Bob agent'],
    messages: [{
      role: 'external-agent',
      sender: 'Bob agent',
      text: 'active runtime details',
      time: '13:29',
      turn: { thinkingText: 'thinking', tools: [{ name: 'read' }] },
    }],
  };

  const conversations = readModel?.buildChatConversations([runtimeConversation as never], (messages, fallback) => messages[0]?.text ?? fallback ?? '') ?? [];

  assert.deepEqual(conversations[0]?.messages.map((message) => message.text), ['active runtime details']);
});

test('bridge chat visibility keeps empty conversations returned by backend state', () => {
  assert.equal(bridgeChatConversationIsVisible({
    outreach: null,
    messages: [],
    peerDisplayName: null,
    peerOwnerName: null,
  }), true);
});
