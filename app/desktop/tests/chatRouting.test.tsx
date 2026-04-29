import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assembleMainContentSlot } from '../src/app/assembleMainContentSlot';
import { buildBridgePageProps } from '../src/app/mainContentShellBuilders';
import { bridgeChatConversationIsVisible } from '../src/app/useWorkspaceViewModels';
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

test('bridge chat visibility keeps empty conversations returned by backend state', () => {
  assert.equal(bridgeChatConversationIsVisible({
    outreach: null,
    messages: [],
    peerDisplayName: null,
    peerOwnerName: null,
  }), true);
});
