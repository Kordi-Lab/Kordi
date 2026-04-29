import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assembleMainContentSlot } from '../src/app/assembleMainContentSlot';
import { buildBridgePageProps } from '../src/app/mainContentShellBuilders';
import { bridgeChatConversationIsVisible } from '../src/app/useWorkspaceViewModels';

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

test('contact Message switches to Chats before selecting an existing conversation', () => {
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

  assert.deepEqual(calls, ['overlay:null', 'nav:chats', 'select:session:bridge:humans:bob']);
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

test('bridge chat visibility keeps empty conversations returned by backend state', () => {
  assert.equal(bridgeChatConversationIsVisible({
    outreach: null,
    messages: [],
    peerDisplayName: null,
    peerOwnerName: null,
  }), true);
});
