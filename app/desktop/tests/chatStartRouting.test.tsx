import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assembleMainContentSlot } from '../src/app/assembleMainContentSlot';
import { assembleSidebarSlot } from '../src/app/assembleSidebarSlot';
import { buildChatsPageProps } from '../src/app/mainContentShellBuilders';

function directPersonConversation() {
  return {
    id: 'session:bridge:humans:bob',
    canonicalSessionId: 'session:bridge:humans:bob',
    name: 'Bob',
    type: 'person',
    subtitle: '',
    unread: 0,
    collaborationSources: ['Bridge'],
    trust: 'Bridge',
    directness: 'Direct chat',
    participants: ['Me', 'Bob'],
    canonicalParticipants: [{
      id: 'human:bob',
      name: 'Bob',
      kind: 'human',
      role: 'delegate',
      source: 'bridge',
      sourceIdentityId: 'node-shared',
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
    collaborationSources: ['Bridge'],
    trust: 'Bridge',
    directness: 'Agent thread',
    participants: ['Me', 'Bob agent'],
    canonicalParticipants: [{
      id: 'agent:bob',
      name: 'Bob agent',
      kind: 'agent',
      role: 'delegate',
      source: 'bridge',
      sourceIdentityId: 'node-shared',
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
    handleAddCollaborationContact: async () => {},
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
    activeCollaborationHost: null,
    localProfileAvatarSeed: null,
    refreshDesktopCollaboration: async () => {},
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
    handleStartChatWithPerson: async () => { calls.push('startChatWithPerson'); },
    handleOpenCollaborationConversation: async () => { calls.push('openBridge'); },
    handleStartCollaborationPersonSession: async (target: Record<string, unknown>) => { calls.push(`startPerson:${target.hostId}:${target.nodeId}:${target.humanId}`); },
    handleStartChatWithAgent: async (agent: Record<string, unknown>) => { calls.push(`startAgent:${agent.sourceHostId}:${agent.sourceParticipantId}:${agent.sourceAgentId}`); },
    setContactOverlayMode: (value: unknown) => calls.push(`overlay:${String(value)}`),
    displayedAgents: [],
    filteredGroupedContacts: [],
    contactRequests: [],
    activeContact: {},
    activeContactRequest: {},
    getStatusBadgeClass: () => '',
    desktopCollaborationState: null,
    activeCollaborationPeople: [],
    activeCollaborationAgents: [],
    handleCreateChatSession: async () => { calls.push('createLocal'); },
    setIsContactRequestsOpen: () => {},
    setExpandedContactGroups: () => {},
    setActiveContactGroup: () => {},
    setActiveContactId: () => {},
    setActiveAgentId: () => {},
    setIsAgentOverlayOpen: () => {},
    handleSelectBridgeHost: async () => {},
    handleCreateBridgeDraft: () => {},
    refreshDesktopCollaboration: async () => {},
    handleSaveBridgeSettings: async () => {},
    handleRemoveBridgeHost: async () => {},
    handleCopyBridgeText: async () => {},
    handleOpenBridgeConfigFolder: async () => {},
    handleRevealBridgeStorageFile: async () => {},
    handleExportBridgeHostsConfig: async () => {},
    handleImportBridgeHostsConfig: async () => {},
    handleAddCollaborationContact: async () => {},
    handleSetBridgeDiscoveryMode: async () => {},
    handleCreateBridgeAgent: async () => {},
    handleActivateBridgeAgent: async () => {},
    handleSetDefaultBridgeAgent: async () => {},
    handleRemoveCollaborationContact: async () => {},
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

test('sidebar chat-create private cloud agent option routes to the selected cloud agent', async () => {
  const calls: string[] = [];
  const element = assembleSidebarSlot(baseSidebarArgs({
    handleCreateChatSession: async () => { calls.push('createLocal'); },
    handleStartChatWithAgent: async (agent: Record<string, unknown>) => { calls.push(`startCloudAgent:${agent.cloudAgentId}`); },
  }) as never) as never as { props: { onStartChatWithAgent: (agent: Record<string, unknown>) => Promise<void> } };

  await element.props.onStartChatWithAgent({
    id: 'cloud-agent:cloud_agent_abc',
    isOwned: true,
    cloudAgentId: 'cloud_agent_abc',
    name: 'Kordi Project Driver',
  });

  assert.deepEqual(calls, ['startCloudAgent:cloud_agent_abc']);
});

test('contact Message starts a fresh person session instead of selecting an existing one', () => {
  const calls: string[] = [];
  const element = assembleMainContentSlot(baseShellArgs(calls) as never) as never as { props: { contactsPageProps: { onMessageContact: (contact: Record<string, unknown>) => void } } };

  element.props.contactsPageProps.onMessageContact({
    id: 'contact-bob',
    classType: 'other-users',
    sourceHumanId: 'human-bob',
    sourceParticipantId: 'node-shared',
    sourceHostId: 'host-1',
    name: 'Bob',
    owner: 'Bob',
    sourceRuntime: 'person',
  });

  assert.deepEqual(calls, ['overlay:null', 'startPerson:host-1:node-shared:human-bob']);
});

test('contact detail delete removes the bridge contact and closes the overlay', async () => {
  const calls: string[] = [];
  const element = assembleMainContentSlot(baseShellArgs(calls, {
    handleRemoveCollaborationContact: async (hostId: string, peerNodeId: string) => {
      calls.push(`remove:${hostId}:${peerNodeId}`);
    },
  }) as never) as never as { props: { contactsPageProps: { onRemoveContact: (contact: Record<string, unknown>) => Promise<void> } } };

  await element.props.contactsPageProps.onRemoveContact({
    id: 'contact-bob',
    classType: 'other-users',
    sourceParticipantId: 'node-shared',
    sourceHostId: 'host-1',
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
    sourceAgentId: 'agent-bob',
    sourceParticipantId: 'node-shared',
    sourceHostId: 'host-1',
    name: 'Bob agent',
    sourceRuntime: 'kordi-desktop',
  });

  assert.deepEqual(calls, ['startAgent:host-1:node-shared:agent-bob']);
});

test('private cloud-created agent Message routes to that agent instead of Kordi', () => {
  const calls: string[] = [];
  const element = assembleMainContentSlot(baseShellArgs(calls, {
    handleStartChatWithAgent: async (agent: Record<string, unknown>) => { calls.push(`startCloudAgent:${agent.cloudAgentId}`); },
  }) as never) as never as { props: { agentsPageProps: { onMessageAgent: (agent: Record<string, unknown>) => void } } };

  element.props.agentsPageProps.onMessageAgent({
    id: 'cloud-agent:cloud_agent_abc',
    cloudAgentId: 'cloud_agent_abc',
    isOwned: true,
    name: 'Kordi Project Driver',
  });

  assert.deepEqual(calls, ['startCloudAgent:cloud_agent_abc']);
});

test('external agent contact Message starts an agent session instead of routing to the person space', () => {
  const calls: string[] = [];
  const element = assembleMainContentSlot(baseShellArgs(calls, {
    chatConversations: [directPersonConversation(), directAgentConversation()],
  }) as never) as never as { props: { contactsPageProps: { onMessageContact: (contact: Record<string, unknown>) => void } } };

  element.props.contactsPageProps.onMessageContact({
    id: 'contact-bob-agent',
    classType: 'other-users-agents',
    sourceHumanId: 'human-bob',
    sourceAgentId: 'agent-bob',
    sourceParticipantId: 'node-shared',
    sourceHostId: 'host-1',
    name: 'Bob agent',
    owner: 'Bob',
    sourceRuntime: 'kordi-desktop',
  });

  assert.deepEqual(calls, ['overlay:null', 'startAgent:host-1:node-shared:agent-bob']);
});



test('chat transcript contact-request hint calls Add contact for the active bridge person', async () => {
  const calls: string[] = [];
  const props = buildChatsPageProps(baseShellArgs(calls, {
    activeConv: {
      ...directPersonConversation(),
      collaborationTarget: {
        hostId: 'host-1',
        nodeId: 'node-shared',
        displayName: 'Bob',
        ownerName: 'Bob',
        runtime: 'person',
      },
    },
    handleAddCollaborationContact: async (hostId: string, peerNodeId: string) => {
      calls.push(`add:${hostId}:${peerNodeId}`);
    },
  }) as never) as never as {
    runtime: { onRequestCollaborationContact?: () => Promise<void> | void };
  };

  await props.runtime.onRequestCollaborationContact?.();

  assert.deepEqual(calls, ['add:host-1:node-shared']);
});

test('chat transcript member profile reuses the normal person-chat route', () => {
  const calls: string[] = [];
  const startPerson = async () => { calls.push('message'); };
  const props = buildChatsPageProps(baseShellArgs(calls, {
    handleStartChatWithPerson: startPerson,
  }) as never);

  assert.equal(props.runtime.onMessageContact, startPerson);
});
