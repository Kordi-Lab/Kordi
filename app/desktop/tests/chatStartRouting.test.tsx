import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assembleMainContentSlot } from '../src/app/assembleMainContentSlot';
import { assembleSidebarSlot } from '../src/app/assembleSidebarSlot';
import { buildBridgePageProps, buildChatsPageProps } from '../src/app/mainContentShellBuilders';

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
    isDesktopChatLoading: false,
    desktopChatError: null,
    filteredConversations: [],
    participantSpaces: [],
    contactParticipantSpaces: [],
    agentParticipantSpaces: [],
    activeConvId: '',
    handleSelectChatSession: async () => {},
    handleStartChatWithPerson: async () => {},
    handleStartChatWithAgent: async () => {},
    handleCreateChatGroup: async () => {},
    handleAddBridgeContact: async () => {},
    handleCreateChatSessionInParticipantSpace: async () => {},
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
    addableContacts: [],
    contactRequests: [],
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

test('contact detail delete removes the bridge contact and closes the overlay', async () => {
  const calls: string[] = [];
  const element = assembleMainContentSlot(baseShellArgs(calls, {
    handleRemoveBridgeContact: async (hostId: string, peerNodeId: string) => {
      calls.push(`remove:${hostId}:${peerNodeId}`);
    },
  }) as never) as never as { props: { contactsPageProps: { onRemoveContact: (contact: Record<string, unknown>) => Promise<void> } } };

  await element.props.contactsPageProps.onRemoveContact({
    id: 'contact-bob',
    classType: 'other-users',
    bridgePeerNodeId: 'node-shared',
    bridgeHostId: 'host-1',
    name: 'Bob',
  });

  assert.deepEqual(calls, ['remove:host-1:node-shared', 'overlay:null']);
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

test('chat transcript contact-request hint calls Add contact for the active bridge person', async () => {
  const calls: string[] = [];
  const props = buildChatsPageProps(baseShellArgs(calls, {
    activeConv: {
      ...directPersonConversation(),
      bridgeTarget: {
        hostId: 'host-1',
        nodeId: 'node-shared',
        displayName: 'Bob',
        ownerName: 'Bob',
        runtime: 'person',
      },
    },
    handleAddBridgeContact: async (hostId: string, peerNodeId: string) => {
      calls.push(`add:${hostId}:${peerNodeId}`);
    },
  }) as never) as never as { onRequestBridgeContact?: () => Promise<void> | void };

  await props.onRequestBridgeContact?.();

  assert.deepEqual(calls, ['add:host-1:node-shared']);
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
