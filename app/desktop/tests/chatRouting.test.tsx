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
import { buildParticipantSpaces } from '../src/features/chat/participantSpaces';

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
    chatFilter: 'latest',
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
    handleStartChatWithAgent: async (agent: Record<string, unknown>) => { calls.push(`startAgent:${agent.bridgeHostId}:${agent.bridgePeerNodeId}:${agent.bridgeAgentId}`); },
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
  assert.equal(typeof element.props.onStartChatWithAgent, 'function');
  assert.equal(element.props.onCreateChatGroup, createGroup);
  assert.equal(element.props.onRenameChatGroup, renameGroup);
  assert.equal(element.props.onAddChatGroupMembers, addMembers);
  assert.equal(element.props.onRemoveChatGroupMember, removeMember);
  assert.equal(element.props.onSetChatGroupAdmin, setAdmin);
});

test('sidebar chat-create agent option opens owned agents with local My chats creation', async () => {
  const calls: string[] = [];
  const element = assembleSidebarSlot(baseSidebarArgs({
    handleCreateChatSession: async () => { calls.push('createLocal'); },
    handleStartChatWithAgent: async (agent: Record<string, unknown>) => { calls.push(`startAgent:${agent.id}`); },
  }) as never) as never as { props: { onStartChatWithAgent: (agent: Record<string, unknown>) => Promise<void> } };

  await element.props.onStartChatWithAgent({ id: 'agent:local', isOwned: true });
  await element.props.onStartChatWithAgent({ id: 'agent:remote', isOwned: false });

  assert.deepEqual(calls, ['createLocal', 'startAgent:agent:remote']);
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

test('agent Message starts a fresh external agent session under My chats', () => {
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

  assert.deepEqual(calls, ['startAgent:host-1:node-shared:agent-bob']);
});

test('external agent contact Message starts an agent session instead of routing to the person space', () => {
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

  assert.deepEqual(calls, ['overlay:null', 'startAgent:host-1:node-shared:agent-bob']);
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

test('bridge Add + chat without a peer runtime defaults to a person session', () => {
  const calls: string[] = [];
  const props = buildBridgePageProps(baseShellArgs(calls, {
    activeNav: 'bridge',
    chatConversations: [],
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

  props.onOpenBridgeConversation('host-1', 'node-new');

  assert.deepEqual(calls, ['startPerson:host-1:node-new:undefined']);
});

test('bridge Chat starts an agent session instead of selecting an existing same-node person conversation', () => {
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

  assert.deepEqual(calls, ['startAgent:host-1:node-shared:agent-bob']);
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
      chatFilter: 'latest',
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

test('canonical read model keeps receiver group display name and normalizes stale remote self roles', () => {
  const readModel = createCanonicalSessionReadModel({
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:user1',
      displayName: 'Testuser1',
      humanIdentityId: 'human:user1',
      activeAgentIdentityId: null,
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:user1', kind: 'human', displayName: 'Testuser1', source: 'bridge', humanId: 'kh_user1', bridgeNodeId: 'kd_user1', avatarKey: 'user1', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:user2', kind: 'human', displayName: 'Testuser2', source: 'bridge', humanId: 'kh_user2', bridgeNodeId: 'kd_user2', avatarKey: 'user2', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:user3', kind: 'human', displayName: 'Testuser3', source: 'bridge', humanId: 'kh_user3', bridgeNodeId: 'kd_user3', avatarKey: 'user3', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [{
      id: 'session:group:shared',
      kind: 'group',
      title: 'New test group',
      status: 'active',
      createdByIdentityId: 'human:user2',
      primaryIdentityId: null,
      relationshipIdentityId: null,
      metadata: { source: 'bridge-session-thread', groupId: 'session:group:shared', groupSpaceId: 'session:group:shared' },
      createdAtMs: 1,
      updatedAtMs: 1,
      lastMessageAtMs: 2,
    }],
    participants: [
      { sessionId: 'session:group:shared', identityId: 'human:user1', role: 'self', state: 'active', addedByIdentityId: 'human:user2', addedAtMs: 1 },
      { sessionId: 'session:group:shared', identityId: 'human:user2', role: 'self', state: 'active', addedByIdentityId: 'human:user2', addedAtMs: 1 },
      { sessionId: 'session:group:shared', identityId: 'human:user3', role: 'person', state: 'active', addedByIdentityId: 'human:user2', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:group:first', sessionId: 'session:group:shared', senderIdentityId: 'human:user2', senderRole: 'person', messageKind: 'text', contentText: 'hi every one', content: { sender: 'Testuser2', timeLabel: '00:02' }, status: 'sent', sequenceNum: 1, createdAtMs: 2, updatedAtMs: 2, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'group:first' },
    ],
    delegatedExchanges: [],
    contextSnapshots: [],
    presence: [],
  } as never);

  const conversations = readModel?.buildChatConversations([], (messages, fallback) => messages[0]?.text ?? fallback ?? '') ?? [];
  const space = buildParticipantSpaces(conversations).find((candidate) => candidate.id === 'group:session:group:shared');

  assert.equal(space?.title, 'New test group');
  assert.deepEqual(space?.participants.filter((participant) => participant.role === 'self').map((participant) => participant.id), ['human:user1']);
});

test('canonical read model sorts group latest by chat activity instead of metadata sync touches', () => {
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
      { id: 'human:alice', kind: 'human', displayName: 'Alice', source: 'bridge', avatarKey: 'alice', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:bob', kind: 'human', displayName: 'Bob', source: 'bridge', avatarKey: 'bob', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      {
        id: 'session:group:old-empty',
        kind: 'group',
        title: 'Alice, Bob',
        status: 'active',
        createdByIdentityId: 'human:me',
        primaryIdentityId: null,
        relationshipIdentityId: null,
        metadata: { createdFrom: 'chat-create-flow', customName: 'Alice, Bob', groupId: 'session:group:old-empty', groupSpaceId: 'session:group:old-empty' },
        createdAtMs: 1_000,
        updatedAtMs: 50_000,
        lastMessageAtMs: null,
      },
      {
        id: 'session:group:testgroup-two',
        kind: 'group',
        title: 'testgroup two',
        status: 'active',
        createdByIdentityId: 'human:me',
        primaryIdentityId: null,
        relationshipIdentityId: null,
        metadata: { createdFrom: 'chat-create-flow', customName: 'testgroup two', groupId: 'session:group:testgroup-two', groupSpaceId: 'session:group:testgroup-two' },
        createdAtMs: 40_000,
        updatedAtMs: 40_000,
        lastMessageAtMs: 45_000,
      },
    ],
    participants: [
      { sessionId: 'session:group:old-empty', identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:group:old-empty', identityId: 'human:alice', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:group:old-empty', identityId: 'human:bob', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:group:testgroup-two', identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:group:testgroup-two', identityId: 'human:alice', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:group:testgroup-two', identityId: 'human:bob', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:group:hi', sessionId: 'session:group:testgroup-two', senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'hi', content: { sender: 'Me', timeLabel: '09:41' }, status: 'sent', sequenceNum: 1, createdAtMs: 45_000, updatedAtMs: 45_000, contentHash: null, sourceTransport: 'desktop-chat-ui', sourceEventId: 'group:hi' },
    ],
    delegatedExchanges: [],
    contextSnapshots: [],
    presence: [],
  } as never);

  const conversations = readModel?.buildChatConversations([], (messages, fallback) => messages[messages.length - 1]?.text ?? fallback ?? '') ?? [];
  const spaces = buildParticipantSpaces(conversations);

  assert.equal(spaces[0]?.title, 'testgroup two');
  assert.equal(spaces[0]?.sessions[0]?.canonicalSessionId, 'session:group:testgroup-two');
});

test('canonical read model names chat-created direct and group sessions from the first user message', () => {
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
      { id: 'human:alice', kind: 'human', displayName: 'Alice', source: 'local', avatarKey: 'alice', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:bob', kind: 'human', displayName: 'Bob', source: 'local', avatarKey: 'bob', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      {
        id: 'session:direct-person:alice-one',
        kind: 'direct-person',
        title: 'Alice',
        status: 'active',
        createdByIdentityId: 'human:me',
        primaryIdentityId: 'human:alice',
        relationshipIdentityId: 'human:alice',
        metadata: { createdFrom: 'chat-create-flow', contactId: 'contact:alice' },
        createdAtMs: 1,
        updatedAtMs: 1,
        lastMessageAtMs: 10,
      },
      {
        id: 'session:group:crew-root',
        kind: 'group',
        title: 'Design crew',
        status: 'active',
        createdByIdentityId: 'human:me',
        primaryIdentityId: null,
        relationshipIdentityId: null,
        metadata: { createdFrom: 'chat-create-flow', customName: 'Design crew', groupId: 'session:group:crew-root', groupSpaceId: 'session:group:crew-root' },
        createdAtMs: 1,
        updatedAtMs: 1,
        lastMessageAtMs: 20,
      },
    ],
    participants: [
      { sessionId: 'session:direct-person:alice-one', identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:direct-person:alice-one', identityId: 'human:alice', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:group:crew-root', identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:group:crew-root', identityId: 'human:alice', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:group:crew-root', identityId: 'human:bob', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:direct:first', sessionId: 'session:direct-person:alice-one', senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'Plan lunch tomorrow with the launch notes before standup', content: { sender: 'Me', timeLabel: '10:01' }, status: 'sent', sequenceNum: 1, createdAtMs: 10, updatedAtMs: 10, contentHash: null, sourceTransport: 'desktop-chat-ui', sourceEventId: 'direct:first' },
      { id: 'msg:group:first', sessionId: 'session:group:crew-root', senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'Review launch plan and assign owners before demo', content: { sender: 'Me', timeLabel: '10:02' }, status: 'sent', sequenceNum: 1, createdAtMs: 20, updatedAtMs: 20, contentHash: null, sourceTransport: 'desktop-chat-ui', sourceEventId: 'group:first' },
    ],
    delegatedExchanges: [],
    contextSnapshots: [],
    presence: [],
  } as never);

  const conversations = readModel?.buildChatConversations([], (messages, fallback) => messages[0]?.text ?? fallback ?? '') ?? [];
  const directConversation = conversations.find((conversation) => conversation.id === 'session:direct-person:alice-one');
  const groupConversation = conversations.find((conversation) => conversation.id === 'session:group:crew-root');
  const groupSpace = buildParticipantSpaces(conversations).find((space) => space.id === 'group:session:group:crew-root');

  assert.equal(directConversation?.name, 'Plan lunch tomorrow with the launch notes before');
  assert.equal(groupConversation?.name, 'Review launch plan and assign owners before demo');
  assert.equal(groupSpace?.title, 'Design crew');
  assert.equal(groupSpace?.sessions[0]?.title, 'Review launch plan and assign owners before demo');
});

test('canonical read model keeps blank selected-agent sessions visible under My chats', () => {
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
      { id: 'agent:reviewer', kind: 'agent', displayName: 'Reviewer', source: 'local', avatarKey: 'reviewer', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      {
        id: 'session:self-agent:selected-reviewer',
        kind: 'self-agent',
        title: 'Reviewer',
        status: 'active',
        createdByIdentityId: 'human:me',
        primaryIdentityId: 'agent:reviewer',
        relationshipIdentityId: null,
        metadata: { createdFrom: 'chat-create-flow', agentId: 'agent:reviewer', participantSpaceKind: 'self' },
        createdAtMs: 2,
        updatedAtMs: 2,
        lastMessageAtMs: null,
      },
    ],
    participants: [
      { sessionId: 'session:self-agent:selected-reviewer', identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 2 },
      { sessionId: 'session:self-agent:selected-reviewer', identityId: 'agent:reviewer', role: 'delegate', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 2 },
    ],
    messages: [],
    delegatedExchanges: [],
    contextSnapshots: [],
    presence: [],
  });

  const conversations = readModel?.buildChatConversations([], () => '') ?? [];

  assert.equal(conversations.length, 1);
  assert.equal(conversations[0]?.id, 'session:self-agent:selected-reviewer');
  assert.equal(conversations[0]?.type, 'owned-agent');
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
      chatFilter: 'latest',
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

test('canonical read model replaces bridge relay copy with active local owned-agent group turn', () => {
  const sessionId = 'session:group:local-owner-duplicate';
  const localText = 'I’ll quickly check current public info/reviews for Al-Marsa Restaurant pricing before answering.\n\nAl-Marsa Restaurant in KAUST is probably **medium to expensive**.';
  const relayText = 'I’ll quickly check current public info/reviews for Al-Marsa Restaurant pricing before answering.Al-Marsa Restaurant in KAUST is probably **medium to expensive**.';
  const canonicalState = {
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Testuser4',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: 'agent:local',
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Testuser4', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:peer', kind: 'human', displayName: 'Testuser6', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-peer', humanId: 'human-peer', avatarKey: 'human-peer', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:local', kind: 'agent', displayName: 'Kordi', source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent-local', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'group', title: 'KAUST weekend', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: null, relationshipIdentityId: null, metadata: { source: 'bridge-session-thread', groupSpaceId: sessionId }, createdAtMs: 1, updatedAtMs: 3, lastMessageAtMs: 3 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:peer', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:local', role: 'owned-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:request', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: '@Kordi is Al-Marsa Restaurant expensive?', content: { sender: 'You', timeLabel: '12:51' }, status: 'sent', sequenceNum: 1, createdAtMs: 1_000, updatedAtMs: 1_000, contentHash: null, sourceTransport: 'desktop-chat', sourceEventId: 'request' },
      { id: 'msg:bridge-relay', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: relayText, content: { sender: "Testuser4's Kordi", timeLabel: '12:52', kind: 'session-relay', deliveryState: 'responded', requestId: 'bridge_req_local_group' }, status: 'complete', sequenceNum: 2, createdAtMs: 2_000, updatedAtMs: 2_000, contentHash: null, sourceTransport: 'desktop-bridge-session-relay', sourceEventId: 'relay' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };
  const localRuntimeConversation = {
    id: sessionId,
    canonicalSessionId: sessionId,
    name: 'KAUST weekend',
    type: 'owned-agent',
    subtitle: '',
    unread: 0,
    bridges: ['Local'],
    trust: 'Owned',
    directness: 'Group chat',
    participants: ['Me', 'My Kordi', 'Testuser6'],
    messages: [{
      role: 'owned-agent',
      sender: 'My Kordi',
      text: '',
      time: '12:52',
      turn: {
        id: 'local-turn-al-marsa',
        sessionId,
        prompt: '@Kordi is Al-Marsa Restaurant expensive?',
        status: 'succeeded',
        message: 'Response complete',
        assistantText: localText,
        thinkingText: 'Considering web search options',
        tools: [{ id: 'tool-search', name: 'web_search', status: 'done', arguments: '', liveOutput: '', resultText: 'Al Marsa listing', detail: null, isError: false }],
        completed: true,
        succeeded: true,
        error: null,
      },
    }],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const conversations = readModel?.buildChatConversations([localRuntimeConversation as never], (messages, fallback) => messages.at(-1)?.turn?.assistantText ?? fallback ?? '') ?? [];
  const messages = conversations[0]?.messages ?? [];

  assert.deepEqual(messages.map((message) => message.text || message.turn?.assistantText), [
    '@Kordi is Al-Marsa Restaurant expensive?',
    localText,
  ]);
  assert.equal(messages[1]?.turn?.id, 'local-turn-al-marsa');
  assert.deepEqual(messages[1]?.turn?.tools.map((tool: { name: string }) => tool.name), ['web_search']);
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

test('canonical read model hides stale bridge processing placeholders after later no-mention human activity', () => {
  const sessionId = 'session:group:no-mention-after-processing';
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
      { id: 'agent:peer', kind: 'agent', displayName: "Peer's Kordi", source: 'bridge', ownerIdentityId: 'human:peer', sourceHostId: 'host-1', bridgeNodeId: 'node-peer', agentId: 'agent-peer', avatarKey: 'agent-peer', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'group', title: 'Group', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: null, relationshipIdentityId: null, metadata: { source: 'bridge-session-thread', groupId: sessionId, groupSpaceId: sessionId }, createdAtMs: 1, updatedAtMs: 20 * 60_000, lastMessageAtMs: 20 * 60_000 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:peer', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:peer', role: 'external-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:before', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'plain chat before', content: { sender: 'Me', timeLabel: '12:00' }, status: 'sent', sequenceNum: 1, createdAtMs: 1_000, updatedAtMs: 1_000, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'before' },
      { id: 'msg:processing', sessionId, senderIdentityId: 'agent:peer', senderRole: 'external-agent', messageKind: 'agent-turn', contentText: 'processing...', content: { sender: "Peer's Kordi", timeLabel: '12:01', kind: 'session-relay', deliveryState: 'processing', requestId: 'bridge_req_stale' }, status: 'processing', sequenceNum: 2, createdAtMs: 2_000, updatedAtMs: 2_000, contentHash: null, sourceTransport: 'desktop-bridge-session-relay', sourceEventId: 'processing' },
      { id: 'msg:image', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: '', content: { sender: 'Me', timeLabel: '12:20', attachments: [{ kind: 'image', name: 'Screenshot.png', formatLabel: 'PNG', localPath: '/tmp/Screenshot.png' }] }, status: 'sent', sequenceNum: 3, createdAtMs: 20 * 60_000, updatedAtMs: 20 * 60_000, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'image-no-mention' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const messages = readModel.messages(sessionId);

  assert.equal(messages.some((message) => message.turn?.status === 'processing'), false);
  assert.deepEqual(messages.map((message) => message.text || message.attachments?.[0]?.name || message.turn?.assistantText), [
    'plain chat before',
    'Screenshot.png',
  ]);
});

test('canonical read model shows fresh bridge-parent processing placeholders for active group agent asks', () => {
  const sessionId = 'session:group:fresh-bridge-parent-processing';
  const now = Date.now();
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
      { id: 'agent:peer', kind: 'agent', displayName: "Peer's Kordi", source: 'bridge', ownerIdentityId: 'human:peer', sourceHostId: 'host-1', bridgeNodeId: 'node-peer', agentId: 'agent-peer', avatarKey: 'agent-peer', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'group', title: 'Group', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: null, relationshipIdentityId: null, metadata: { source: 'bridge-session-thread', groupId: sessionId, groupSpaceId: sessionId }, createdAtMs: 1, updatedAtMs: now, lastMessageAtMs: now },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:peer', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:peer', role: 'external-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:request', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: '@PeersKordi hi', content: { sender: 'Me', timeLabel: '13:01', direction: 'outbound', deliveryState: 'delivered', requestId: 'bridge_req_active' }, status: 'delivered', sequenceNum: 1, createdAtMs: now - 2_000, updatedAtMs: now - 2_000, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'request' },
      { id: 'msg:active-processing', sessionId, senderIdentityId: 'agent:peer', senderRole: 'external-agent', messageKind: 'agent-turn', contentText: 'processing...', content: { sender: "Peer's Kordi", timeLabel: '13:01', kind: 'session-message', direction: 'inbound-response', deliveryState: 'processing', requestId: 'bridge_req_active' }, status: 'processing', sequenceNum: 2, createdAtMs: now - 1_000, updatedAtMs: now - 1_000, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'active-processing' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const messages = readModel.messages(sessionId);

  assert.equal(messages.some((message) => message.turn?.status === 'processing'), true);
  assert.equal(messages.find((message) => message.turn?.status === 'processing')?.turn?.message, 'Processing…');
});

test('canonical read model suppresses stale raw bridge-parent processing placeholders', () => {
  const sessionId = 'session:group:bridge-parent-processing';
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
      { id: 'agent:peer', kind: 'agent', displayName: "Peer's Kordi", source: 'bridge', ownerIdentityId: 'human:peer', sourceHostId: 'host-1', bridgeNodeId: 'node-peer', agentId: 'agent-peer', avatarKey: 'agent-peer', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'group', title: 'Group', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: null, relationshipIdentityId: null, metadata: { source: 'bridge-session-thread', groupId: sessionId, groupSpaceId: sessionId }, createdAtMs: 1, updatedAtMs: 5_000, lastMessageAtMs: 5_000 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:peer', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:peer', role: 'external-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:hello', sessionId, senderIdentityId: 'human:peer', senderRole: 'person', messageKind: 'text', contentText: 'hello', content: { sender: 'Peer', timeLabel: '12:00' }, status: 'sent', sequenceNum: 1, createdAtMs: 1_000, updatedAtMs: 1_000, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'hello' },
      { id: 'msg:active-processing', sessionId, senderIdentityId: 'agent:peer', senderRole: 'external-agent', messageKind: 'agent-turn', contentText: 'Processing...', content: { sender: "Peer's Kordi", timeLabel: '12:01', deliveryState: 'processing', requestId: 'bridge_req_parent_active' }, status: 'processing', sequenceNum: 2, createdAtMs: 2_000, updatedAtMs: 2_000, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'active-processing' },
      { id: 'msg:cancelled-processing', sessionId, senderIdentityId: 'agent:peer', senderRole: 'external-agent', messageKind: 'agent-turn', contentText: 'processing...', content: { sender: "Peer's Kordi", timeLabel: '12:02', deliveryState: 'cancelled', requestId: 'bridge_req_parent_cancelled' }, status: 'cancelled', sequenceNum: 3, createdAtMs: 3_000, updatedAtMs: 3_000, contentHash: null, sourceTransport: 'desktop-bridge-parent', sourceEventId: 'cancelled-processing' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const messages = readModel.messages(sessionId);

  assert.deepEqual(messages.map((message) => message.text || message.turn?.assistantText), ['hello']);
  assert.equal(messages.some((message) => message.turn?.message === 'Processing…'), false);
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

test('canonical read model hides duplicate local-agent group response fanout copies', () => {
  const sessionId = 'session:group:fanout-agent';
  const responseText = 'same weather answer';
  const readModel = createCanonicalSessionReadModel({
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
      { id: 'human:a', kind: 'human', displayName: 'A', source: 'bridge', avatarKey: 'a', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:b', kind: 'human', displayName: 'B', source: 'bridge', avatarKey: 'b', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:local', kind: 'agent', displayName: 'My Kordi', source: 'local', ownerIdentityId: 'human:me', avatarKey: 'agent-local', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'group', title: 'Group', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: null, relationshipIdentityId: null, metadata: { source: 'bridge-session-thread', groupId: sessionId, groupSpaceId: sessionId }, createdAtMs: 1, updatedAtMs: 4, lastMessageAtMs: 4 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:a', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:b', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:request', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: '@MyKordi weather', content: { sender: 'Me', timeLabel: '10:02' }, status: 'sent', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1, contentHash: null, sourceTransport: 'desktop-chat-ui', sourceEventId: 'request' },
      { id: 'msg:copy-a', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: responseText, content: { sender: 'My Kordi', timeLabel: '10:03', kind: 'session-relay', requestId: 'bridge_req_same', bridgeConversationId: 'bridge:a' }, status: 'complete', sequenceNum: 2, createdAtMs: 2, updatedAtMs: 2, contentHash: null, sourceTransport: 'desktop-bridge-session-relay', sourceEventId: 'copy-a' },
      { id: 'msg:copy-b', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: responseText, content: { sender: 'My Kordi', timeLabel: '10:03', kind: 'session-relay', requestId: 'bridge_req_same', bridgeConversationId: 'bridge:b' }, status: 'complete', sequenceNum: 3, createdAtMs: 3, updatedAtMs: 3, contentHash: null, sourceTransport: 'desktop-bridge-session-relay', sourceEventId: 'copy-b' },
    ],
    delegatedExchanges: [],
    contextSnapshots: [],
    presence: [],
  } as never);

  const messages = readModel?.messages(sessionId) ?? [];
  assert.equal(messages.filter((message) => message.role === 'owned-agent' && message.turn?.assistantText === responseText).length, 1);
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

test('canonical read model keeps chat-created bridge agent sessions scoped to their own messages', () => {
  const sessionId = 'session:direct-agent:fresh-thread';
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
      { id: 'human:owner', kind: 'human', displayName: 'Owner', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-owner', humanId: 'human-owner', avatarKey: 'owner', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:remote', kind: 'agent', displayName: "Owner's Kordi", source: 'bridge', ownerIdentityId: 'human:owner', sourceHostId: 'host-1', bridgeNodeId: 'node-owner', agentId: 'agent-remote', avatarKey: 'agent-remote', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'direct-agent', title: "Owner's Kordi", status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'agent:remote', relationshipIdentityId: null, metadata: { createdFrom: 'chat-create-flow', bridgeHostId: 'host-1', peerNodeId: 'node-owner', peerRuntime: 'kordi-desktop', targetAgentId: 'agent-remote' }, createdAtMs: 10, updatedAtMs: 20, lastMessageAtMs: 20 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 10 },
      { sessionId, identityId: 'agent:remote', role: 'delegate', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 10 },
      { sessionId, identityId: 'human:owner', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 20 },
    ],
    messages: [
      { id: 'msg:request', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'fresh private question', content: { sender: 'Me', timeLabel: '14:11' }, status: 'sent', sequenceNum: 1, createdAtMs: 11, updatedAtMs: 11, contentHash: null, sourceTransport: 'desktop-bridge-ui', sourceEventId: 'request' },
      { id: 'msg:response', sessionId, senderIdentityId: 'agent:remote', senderRole: 'external-agent', messageKind: 'agent-turn', contentText: 'fresh private answer', content: { sender: "Owner's Kordi", timeLabel: '14:11' }, status: 'complete', sequenceNum: 2, createdAtMs: 20, updatedAtMs: 20, contentHash: null, sourceTransport: 'desktop-bridge-outreach', sourceEventId: 'response' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };
  const staleBridgeAgentSource = {
    id: 'bridge:host-1:node-owner',
    canonicalSessionId: undefined,
    name: "Owner's Kordi",
    type: 'external-agent',
    subtitle: 'Agent outreach • previous raw bridge store',
    unread: 0,
    bridges: ['Bridge'],
    trust: 'Bridge',
    directness: 'Agent outreach',
    participants: ['Me', 'Owner', "Owner's Kordi"],
    outreach: { parentSessionId: sessionId },
    messages: [
      { role: 'external-agent', sender: "Owner's Kordi", senderType: 'agent', text: '', turn: { id: 'old-turn', sessionId: 'bridge:host-1:node-owner', prompt: '', status: 'complete', message: 'Complete', assistantText: 'stale group answer', thinkingText: '', tools: [], completed: true, succeeded: true, error: null }, time: '12:20' },
      { role: 'user', sender: 'Me', senderType: 'human', text: 'fresh private question', time: '14:11' },
      { role: 'external-agent', sender: "Owner's Kordi", senderType: 'agent', text: '', turn: { id: 'fresh-turn', sessionId: 'bridge:host-1:node-owner', prompt: '', status: 'complete', message: 'Complete', assistantText: 'fresh private answer', thinkingText: '', tools: [], completed: true, succeeded: true, error: null }, time: '14:11' },
    ],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const conversations = readModel?.buildChatConversations([staleBridgeAgentSource as never], (messages, fallback) => messages[0]?.text || messages[0]?.turn?.assistantText || fallback || '') ?? [];
  const conversation = conversations.find((candidate) => candidate.id === sessionId);

  assert.deepEqual(
    conversation?.messages.map((message) => message.text || message.turn?.assistantText),
    ['fresh private question', 'fresh private answer'],
  );
  assert.deepEqual(conversation?.participants, ['Me', "Owner's Kordi"]);
  assert.equal(conversation?.directness, 'Direct chat');
});

test('canonical read model does not show processing for bridge agent outreach without a sent bridge request', () => {
  const sessionId = 'session:direct-agent:stale-outreach';
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
      { id: 'human:testuser2', kind: 'human', displayName: 'testuser2', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-testuser2', humanId: 'human-testuser2', avatarKey: 'human-testuser2', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:testuser2', kind: 'agent', displayName: "testuser2's Kordi", source: 'bridge', ownerIdentityId: 'human:testuser2', sourceHostId: 'host-1', bridgeNodeId: 'node-testuser2', agentId: 'agent-testuser2', avatarKey: 'agent-testuser2', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'direct-agent', title: "testuser2's Kordi", status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'agent:testuser2', relationshipIdentityId: null, metadata: { createdFrom: 'chat-create-flow', bridgeHostId: 'host-1', peerNodeId: 'node-testuser2', peerRuntime: 'kordi-desktop', targetAgentId: 'agent-testuser2' }, createdAtMs: 1, updatedAtMs: 2, lastMessageAtMs: 2 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:testuser2', role: 'external-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:request', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'hello', content: { sender: 'Me', timeLabel: '02:26' }, status: 'sent', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1, contentHash: null, sourceTransport: 'desktop-bridge-ui', sourceEventId: 'request' },
    ],
    delegatedExchanges: [{
      id: 'delegation:bridge:unsent',
      sessionId,
      initiatorIdentityId: 'human:me',
      targetIdentityId: 'agent:testuser2',
      triggerMessageId: 'msg:request',
      requestMessageId: 'msg:request',
      responseMessageId: null,
      transport: 'bridge',
      bridgeHostId: 'host-1',
      bridgeConversationId: 'bridge:host-1:node-testuser2:kordi-desktop',
      bridgeRequestId: null,
      contextPolicy: 'recent-window',
      status: 'processing',
      error: null,
      createdAtMs: 2,
      updatedAtMs: 2,
    }],
    presence: [],
    contextSnapshots: [],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const conversations = readModel?.buildChatConversations([], (messages, fallback) => messages[0]?.text ?? fallback ?? '') ?? [];

  assert.equal(conversations[0]?.messages.some((message) => message.turn?.status === 'processing'), false);
});

test('canonical read model marks bridge mention requests failed when remote agent fails without a response', () => {
  const sessionId = 'session:bridge:humans:failed-delegation';
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
      { id: 'human:testuser3', kind: 'human', displayName: 'Testuser3', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-testuser3', humanId: 'human-testuser3', avatarKey: 'human-testuser3', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:testuser3', kind: 'agent', displayName: "Testuser3's Kordi", source: 'bridge', ownerIdentityId: 'human:testuser3', sourceHostId: 'host-1', bridgeNodeId: 'node-testuser3-agent', agentId: 'agent-testuser3', avatarKey: 'agent-testuser3', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'relationship', title: 'can you see our chat history ?', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:testuser3', relationshipIdentityId: 'human:testuser3', metadata: { source: 'bridge-session-thread', bridgeHostId: 'host-1', peerNodeId: 'node-testuser3', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 5, lastMessageAtMs: 5 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:testuser3', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:testuser3', role: 'external-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:request', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: '@Testuser3sKordi can you see our chat history ?', content: { sender: 'Me', timeLabel: '00:45', mentions: [{ label: 'Testuser3sKordi', targetKind: 'bridge-agent', nodeId: 'node-testuser3-agent' }] }, status: 'sent', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1, contentHash: null, sourceTransport: 'desktop-bridge-ui', sourceEventId: 'request' },
      { id: 'msg:join', sessionId, senderIdentityId: 'human:me', senderRole: 'system', messageKind: 'status', contentText: "Testuser3's Kordi joined via @mention", content: { kind: 'delegation-join-event', targetDisplayName: "Testuser3's Kordi" }, status: 'complete', sequenceNum: 2, createdAtMs: 2, updatedAtMs: 2, contentHash: null, sourceTransport: 'desktop-bridge-outreach', sourceEventId: 'join' },
    ],
    delegatedExchanges: [{
      id: 'delegation:bridge:failed',
      sessionId,
      initiatorIdentityId: 'human:me',
      targetIdentityId: 'agent:testuser3',
      triggerMessageId: 'msg:request',
      requestMessageId: 'msg:request',
      responseMessageId: null,
      transport: 'bridge',
      bridgeHostId: 'host-1',
      bridgeConversationId: 'bridge:host-1:node-testuser3:kordi-desktop',
      bridgeRequestId: 'bridge_req_failed',
      contextPolicy: 'recent-window',
      status: 'failed',
      error: 'ChatGPT OAuth credentials are not usable',
      createdAtMs: 2,
      updatedAtMs: 3,
    }],
    presence: [],
    contextSnapshots: [],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const conversations = readModel?.buildChatConversations([], (messages, fallback) => messages[0]?.text ?? fallback ?? '') ?? [];

  assert.deepEqual(conversations[0]?.messages[0]?.statusChips, ['failed']);
  assert.equal(conversations[0]?.messages.some((message) => message.text.includes('ChatGPT OAuth credentials')), false);
});

test('canonical read model hides bridge agent failure detail behind a generic failed turn', () => {
  const sessionId = 'session:bridge:humans:remote-agent-failure';
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
      { id: 'human:testuser2', kind: 'human', displayName: 'Testuser2', source: 'bridge', sourceHostId: 'host-1', bridgeNodeId: 'node-testuser2', humanId: 'human-testuser2', avatarKey: 'human-testuser2', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:local', kind: 'agent', displayName: 'My Kordi', source: 'local', ownerIdentityId: 'human:me', sourceHostId: 'host-1', bridgeNodeId: 'node-local-agent', agentId: 'agent-local', avatarKey: 'agent-local', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: sessionId, kind: 'relationship', title: 'can you see our chat history ?', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:testuser2', relationshipIdentityId: 'human:testuser2', metadata: { source: 'bridge-session-thread', bridgeHostId: 'host-1', peerNodeId: 'node-testuser2', peerRuntime: 'person' }, createdAtMs: 1, updatedAtMs: 5, lastMessageAtMs: 5 },
    ],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'human:testuser2', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:local', role: 'owned-agent', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'msg:request', sessionId, senderIdentityId: 'human:testuser2', senderRole: 'person', messageKind: 'text', contentText: '@MyKordi can you see our chat history ?', content: { sender: 'Testuser2', timeLabel: '00:45', kind: 'mention-request' }, status: 'read', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1, contentHash: null, sourceTransport: 'desktop-bridge-outreach', sourceEventId: 'request' },
      { id: 'msg:failed-response', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'Failed: ChatGPT OAuth credentials are not usable. Sign in to ChatGPT again.', content: { sender: 'My Kordi', timeLabel: '00:45', deliveryState: 'processing_failed', delegatedExchangeId: 'delegation:bridge:failed' }, status: 'failed', sequenceNum: 2, createdAtMs: 2, updatedAtMs: 2, contentHash: null, sourceTransport: 'desktop-bridge-outreach', sourceEventId: 'failed-response' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const conversations = readModel?.buildChatConversations([], (messages, fallback) => messages[0]?.text ?? fallback ?? '') ?? [];
  const turn = conversations[0]?.messages[1]?.turn;

  assert.equal(turn?.status, 'failed');
  assert.equal(turn?.assistantText, '');
  assert.equal(turn?.error, 'Message failed');
  assert.equal(JSON.stringify(conversations[0]?.messages).includes('ChatGPT OAuth credentials'), false);
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

test('canonical read model excludes left group participants from active conversations', () => {
  const canonicalState = {
    storagePath: '/tmp/canonical.db',
    profile: {
      id: 'profile:local',
      displayName: 'Me',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: 'agent:local',
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:alice', kind: 'human', displayName: 'Alice', source: 'bridge', avatarKey: 'alice', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:bob', kind: 'human', displayName: 'Bob', source: 'bridge', avatarKey: 'bob', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      { id: 'session:group:left', kind: 'group', title: 'Alice, Bob', status: 'active', createdByIdentityId: 'human:me', metadata: {}, createdAtMs: 1, updatedAtMs: 2, lastMessageAtMs: 2 },
    ],
    participants: [
      { sessionId: 'session:group:left', identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:group:left', identityId: 'human:alice', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:group:left', identityId: 'human:bob', role: 'person', state: 'left', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const conversations = readModel?.buildChatConversations([], (messages, fallback) => messages[0]?.text ?? fallback ?? '') ?? [];
  const group = conversations.find((conversation) => conversation.id === 'session:group:left');

  assert.deepEqual(group?.canonicalParticipants?.map((participant) => participant.name), ['Me', 'Alice']);
});

test('canonical read model preserves group space when hydrating from a bridge outreach source', () => {
  const canonicalState = {
    storagePath: '/tmp/canonical.db',
    profile: {
      id: 'profile:local',
      displayName: 'Me',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: 'agent:local',
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'human:bob', kind: 'human', displayName: 'Bob', source: 'bridge', avatarKey: 'bob', humanId: 'kh_bob', bridgeNodeId: 'kd_bob', createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [
      {
        id: 'session:group:invite',
        kind: 'group',
        title: 'Group',
        status: 'active',
        createdByIdentityId: 'human:me',
        metadata: { groupSpaceId: 'session:group:invite', source: 'bridge-session-thread' },
        createdAtMs: 1,
        updatedAtMs: 2,
        lastMessageAtMs: 2,
      },
    ],
    participants: [
      { sessionId: 'session:group:invite', identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: 'session:group:invite', identityId: 'human:bob', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      {
        id: 'msg:group-invite',
        sessionId: 'session:group:invite',
        senderIdentityId: 'human:bob',
        senderRole: 'person',
        messageKind: 'text',
        contentText: 'hi everyone',
        content: { sender: 'Bob', timeLabel: '13:27' },
        status: 'sent',
        sequenceNum: 1,
        createdAtMs: 2,
        updatedAtMs: 2,
        contentHash: null,
        sourceTransport: 'desktop-bridge-parent',
        sourceEventId: 'bridge-group-1',
      },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };
  const bridgeSource = {
    id: 'bridge:host:bob:person',
    canonicalSessionId: 'session:bridge:humans:bob',
    name: 'Bob',
    type: 'person',
    subtitle: 'hi everyone',
    unread: 1,
    bridges: ['Bridge'],
    trust: 'Bridge',
    directness: 'Direct chat',
    participants: ['Me', 'Bob'],
    outreach: { parentSessionId: 'session:group:invite' },
    bridgeUnreadByParentSessionId: { 'session:group:invite': 1 },
    messages: [{ role: 'person', sender: 'Bob', text: 'hi everyone', time: '13:27' }],
  };

  const readModel = createCanonicalSessionReadModel(canonicalState as never);
  const conversations = readModel?.buildChatConversations([bridgeSource as never], (messages, fallback) => messages[0]?.text ?? fallback ?? '') ?? [];
  const group = conversations.find((conversation) => conversation.id === 'session:group:invite');
  const spaces = buildParticipantSpaces(conversations as never);

  assert.equal(group?.participantSpaceId, 'session:group:invite');
  assert.equal(spaces[0]?.kind, 'group');
  assert.equal(spaces[0]?.id, 'group:session:group:invite');
});

test('bridge chat visibility keeps empty conversations returned by backend state', () => {
  assert.equal(bridgeChatConversationIsVisible({
    outreach: null,
    messages: [],
    peerDisplayName: null,
    peerOwnerName: null,
  }), true);
});
