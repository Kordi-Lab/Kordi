import { buildParticipantSpaces } from '../../src/features/chat/participantSpaces';
import type {
  Agent,
  Contact,
  Conversation,
  DesktopCollaborationConversation,
} from '../../src/kordi-app/types';

export type ConversationFixture = Conversation & { _updatedAtMs?: number };

export function conversation(overrides: Partial<ConversationFixture> = {}): ConversationFixture {
  return {
    id: 'session:bob:old',
    canonicalSessionId: 'session:bob:old',
    name: 'Old Bob thread',
    type: 'person',
    subtitle: 'Old preview',
    unread: 1,
    collaborationSources: ['Bridge'],
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

export function contact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 'contact:alice',
    name: 'Alice',
    initials: 'A',
    classType: 'other-users',
    entityType: 'Person',
    subtitle: 'Human contact',
    collaborationSources: ['Bridge'],
    status: 'Online',
    discoverableOn: ['Bridge'],
    detail: 'Works on product',
    owner: 'Alice',
    avatarSeed: 'alice',
    profileImageUrl: null,
    ...overrides,
  };
}

export function bridgeConversation(overrides: Partial<DesktopCollaborationConversation> = {}): DesktopCollaborationConversation {
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
      targetKind: 'agent',
      parentSessionId: null,
      sourceHostId: 'host-1',
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
      sourceHostId: 'host-1',
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

export function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent:kordi',
    name: 'Kordi',
    role: 'Coding partner',
    messaging: 'Available',
    status: 'Ready',
    tasks: 0,
    defaultProvider: 'openai',
    defaultModel: 'gpt-5.2',
    collaborationConfig: 'Bridge',
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

export function baseSidebarProps(overrides: Record<string, unknown> = {}) {
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

  const props = {
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
    activeCollaborationHost: null,
    localProfileAvatarSeed: 'me',
    onRefreshBridge: () => {},
    onCopyBridgeHostUrl: () => {},
    onCreateBridgeDraft: () => {},
    ...overrides,
  };
  return { layout: props, chats: props, projects: props, directory: props, account: props };
}

export function countMatches(value: string, pattern: RegExp) {
  return value.match(pattern)?.length ?? 0;
}
