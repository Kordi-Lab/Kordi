import type { Dispatch, MouseEvent as ReactMouseEvent, MutableRefObject, SetStateAction } from 'react';

import type { ComposerAuthOption, ComposerModelOption, ComposerProviderOption } from '@/kordi-app/components';
import type {
  Agent,
  Contact,
  ContactClass,
  ContactRequest,
  Conversation,
  DesktopAuthProvider,
  DesktopAuthState,
  DesktopBridgeConversation,
  DesktopBridgeHost,
  DesktopBridgeInvite,
  DesktopBridgePeer,
  DesktopBridgeProject,
  DesktopBridgeState,
  DesktopChatProjectInfo,
  DesktopProjectSettings,
  DesktopChatSlashCommand,
  DesktopChatState,
  DesktopChatTurnSnapshot,
  DetailTab,
  EditFilePreview,
  Message,
  Project,
  SessionArtifact,
  ThemeMode,
} from '@/kordi-app/types';

export type ComposerSelection = { mode: string; model: string; thinking: string };
export type ComposerSelectorState = { scope: 'chat' | 'project'; type: 'mode' | 'auth' | 'provider' | 'model' | 'thinking' } | null;
export type AttachmentItem = { id: string; name: string; path: string; kind: 'image' | 'file' };
export type BridgeWizardDraft = {
  mode: 'local' | 'self-hosted' | 'public' | 'join';
  serverUrl: string;
  displayName: string;
  ownerName: string;
};

export type AssembleKordiShellSlotsArgs = {
  isNativeShell: boolean;
  windowWidth: number;
  activeNav: 'chats' | 'contacts' | 'projects' | 'agents' | 'bridge' | 'settings';
  activeConvId: string;
  activeProjectId: string;
  activeProjectSessionId: string;
  activeSettingsSectionId: string;
  isSingleWorkspacePage: boolean;
  collapseChatSessions: boolean;
  showSessionRail: boolean;
  sessionRailWidth: number;
  chatConversations: Conversation[];
  isDesktopChatLoading: boolean;
  desktopChatError: string | null;
  filteredConversations: Conversation[];
  setActiveNav: Dispatch<SetStateAction<'chats' | 'contacts' | 'projects' | 'agents' | 'bridge' | 'settings'>>;
  handleCreateChatSession: () => Promise<void>;
  chatSearch: string;
  setChatSearch: Dispatch<SetStateAction<string>>;
  chatFilter: 'all' | 'people' | 'agents' | 'delegated';
  setChatFilter: Dispatch<SetStateAction<'all' | 'people' | 'agents' | 'delegated'>>;
  runtimeProjects: Project[];
  projectSearch: string;
  setProjectSearch: Dispatch<SetStateAction<string>>;
  filteredProjects: Project[];
  projectSelectedSessionIds: Record<string, string>;
  selectProject: (projectId: string) => void;
  expandedProjectIds: Record<string, boolean>;
  setExpandedProjectIds: Dispatch<SetStateAction<Record<string, boolean>>>;
  groupedContacts: Array<{ id: ContactClass; label: string; items: Contact[] }>;
  displayedContacts: Contact[];
  setActiveContactGroup: Dispatch<SetStateAction<ContactClass>>;
  setActiveContactId: Dispatch<SetStateAction<string>>;
  displayedAgents: Agent[];
  activeBridgeHost: DesktopBridgeHost | null;
  refreshDesktopBridge: () => Promise<unknown>;
  handleCopyBridgeText: (value: string, successMessage: string) => Promise<void>;
  handleCreateBridgeDraft: () => void;
  handleSelectChatSession: (sessionId: string) => Promise<void>;
  handleSelectProjectSession: (projectId: string, sessionId: string) => Promise<void>;

  filteredGroupedContacts: Array<{ id: ContactClass; label: string; items: Contact[] }>;
  isContactRequestsOpen: boolean;
  setIsContactRequestsOpen: Dispatch<SetStateAction<boolean>>;
  contactRequests: ContactRequest[];
  activeContactRequestId: string;
  setActiveContactRequestId: Dispatch<SetStateAction<string>>;
  setContactOverlayMode: Dispatch<SetStateAction<'contact' | 'request' | null>>;
  contactSearch: string;
  setContactSearch: Dispatch<SetStateAction<string>>;
  expandedContactGroups: Record<ContactClass, boolean>;
  setExpandedContactGroups: Dispatch<SetStateAction<Record<ContactClass, boolean>>>;
  activeContactId: string;
  activeContact: Contact;
  activeContactRequest: ContactRequest;
  contactOverlayMode: 'contact' | 'request' | null;
  getStatusBadgeClass: (value: string) => string;
  handleOpenBridgeConversation: (
    hostId: string,
    peerNodeId: string,
    peerDisplayName?: string | null,
    peerOwnerName?: string | null,
    peerRuntime?: string | null,
    project?: DesktopBridgeProject | null,
  ) => Promise<void>;

  activeAgentId: string;
  setActiveAgentId: Dispatch<SetStateAction<string>>;
  activeAgent: Agent;
  isAgentOverlayOpen: boolean;
  setIsAgentOverlayOpen: Dispatch<SetStateAction<boolean>>;

  desktopBridgeState: DesktopBridgeState | null;
  activeBridgePeople: DesktopBridgePeer[];
  activeBridgeAgents: DesktopBridgePeer[];
  bridgeSettingsDraft: { serverUrl: string; displayName: string; ownerName: string; endpoint: string } | null;
  setBridgeSettingsDraft: Dispatch<SetStateAction<{ serverUrl: string; displayName: string; ownerName: string; endpoint: string } | null>>;
  isDesktopBridgeSaving: boolean;
  desktopBridgeError: string | null;
  bridgeWizardOpen: boolean;
  setBridgeWizardOpen: Dispatch<SetStateAction<boolean>>;
  bridgeWizardStep: number;
  setBridgeWizardStep: Dispatch<SetStateAction<number>>;
  bridgeWizardDraft: BridgeWizardDraft;
  setBridgeWizardDraft: Dispatch<SetStateAction<BridgeWizardDraft>>;
  handleSelectBridgeHost: (hostId: string) => Promise<void>;
  openBridgeWizard: () => void;
  handleStartLocalBridgeHost: () => void;
  handleStopLocalBridgeHost: () => void;
  handleSaveBridgeSettings: () => Promise<void>;
  handleRemoveBridgeHost: (hostId: string) => Promise<void>;
  handleBridgeWizardPrimary: () => Promise<void>;

  settingsRailWidth: number;
  settingsContentRef: MutableRefObject<HTMLDivElement | null>;
  setActiveSettingsSectionId: Dispatch<SetStateAction<string>>;
  settingsSections: typeof import('@/kordi-app/data').settingsSections;
  activeSettingsSection: (typeof import('@/kordi-app/data').settingsSections)[number];
  authSettingsLayoutWidth: number;
  desktopAuthState: DesktopAuthState | null;
  isDesktopAuthLoading: boolean;
  desktopAuthError: string | null;
  activeLoginProviderId: string;
  selectAuthProvider: (providerId: string) => void;
  openLoginFlow: (provider: DesktopAuthProvider, mode: 'oauth' | 'api-key', options?: { authority?: string; requireAuthority?: boolean }) => void;
  refreshDesktopAuth: () => Promise<unknown>;
  handleSelectAuthChoice: (providerId: string, choice: string) => Promise<void>;
  handleRemoveAuthProfile: (providerId: string, profileId: string) => Promise<void>;
  handleLogoutProvider: (providerId: string) => Promise<void>;
  projectSettingsDraft: DesktopProjectSettings | null;
  isDesktopProjectSaving: boolean;
  desktopProjectError: string | null;
  handleSaveProjectSettings: () => Promise<void>;
  updateProjectSettingsDraft: (field: 'name' | 'context' | 'systemPrompt' | 'sharedSources', value: string | DesktopProjectSettings['sharedSources']) => void;
  themeMode: ThemeMode;
  setThemeMode: Dispatch<SetStateAction<ThemeMode>>;

  showRightDetailRail: boolean;
  isDetailPanelCollapsed: boolean;
  setIsDetailPanelCollapsed: Dispatch<SetStateAction<boolean>>;
  setIsSessionPanelCollapsed: Dispatch<SetStateAction<boolean>>;
  activeProject: Project;
  activeProjectSession: Project['sessions'][number];
  desktopSessionRenameDraft: string;
  setDesktopSessionRenameDraft: Dispatch<SetStateAction<string>>;
  isEditingDesktopSessionTitle: boolean;
  setIsEditingDesktopSessionTitle: Dispatch<SetStateAction<boolean>>;
  handleRenameDesktopSession: (fallbackName?: string) => Promise<void>;
  activeProjectBridgeHost: DesktopBridgeHost | null;
  activeProjectBridgeProject: DesktopBridgeProject | null;
  chatTranscriptScrollRef: MutableRefObject<HTMLDivElement | null>;
  onProjectTranscriptScroll: () => void;
  onChatTranscriptScroll: () => void;
  activeSourcePreview: EditFilePreview | null;
  setActiveSourcePreview: Dispatch<SetStateAction<EditFilePreview | null>>;
  activeArtifactId: string | null;
  setActiveArtifactId: Dispatch<SetStateAction<string | null>>;
  activeChatArtifacts: SessionArtifact[];
  activeProjectArtifacts: SessionArtifact[];
  desktopLiveTurn: DesktopChatTurnSnapshot | null;
  filteredProjectSlashCommands: DesktopChatSlashCommand[];
  filteredChatSlashCommands: DesktopChatSlashCommand[];
  chatSlashMenuIndex: number;
  setChatSlashMenuIndex: Dispatch<SetStateAction<number>>;
  acceptProjectSlashCommand: (value: string) => void;
  acceptChatSlashCommand: (value: string) => void;
  chatAttachmentInputRef: MutableRefObject<HTMLInputElement | null>;
  chatComposerAttachments: AttachmentItem[];
  saveDesktopAttachments: (files: File[]) => Promise<AttachmentItem[]>;
  removeChatComposerAttachment: (id: string) => void;
  projectComposerText: string;
  chatComposerText: string;
  updateProjectComposerDraft: (value: string, target: HTMLTextAreaElement) => void;
  updateChatComposerDraft: (value: string, target: HTMLTextAreaElement) => void;
  setProjectComposerText: (value: string) => void;
  setChatComposerText: (value: string) => void;
  composerControlsRef: MutableRefObject<HTMLDivElement | null>;
  activeRuntimeSessionId?: string;
  activeRuntimeContextStatus?: DesktopChatState['activeSession']['contextWindowStatus'];
  activeRuntimeCacheText?: string | null;
  composerSelectionProject: ComposerSelection;
  composerSelectionChat: ComposerSelection;
  openComposerSelector: ComposerSelectorState;
  toggleComposerSelector: (scope: 'chat' | 'project', type: 'mode' | 'auth' | 'provider' | 'model' | 'thinking') => void;
  selectComposerValue: (scope: 'chat' | 'project', type: 'mode' | 'auth' | 'provider' | 'model' | 'thinking', value: string) => void;
  composerAuthLabelProject: string;
  composerAuthLabelChat: string;
  composerAuthOptionsProject: ComposerAuthOption[];
  composerAuthOptionsChat: ComposerAuthOption[];
  selectComposerAuthChoice: (scope: 'chat' | 'project', providerId: string, choice: string) => void;
  selectComposerProviderChoice: (scope: 'chat' | 'project', option: ComposerProviderOption) => void;
  composerProviderOptions: ComposerProviderOption[];
  chatModelOptions: ComposerModelOption[] | undefined;
  isDesktopChatSending: boolean;
  handleStopDesktopChatTurn: () => void;
  handleSendProjectMessage: () => void;
  handleSendChatMessage: () => void;
  showChatDetailRail: boolean;
  activeDetailTab: DetailTab;
  setActiveDetailTab: Dispatch<SetStateAction<DetailTab>>;
  activeProjectLastMessage: Message;
  isProjectBridgeBusy: boolean;
  bridgeInvite: DesktopBridgeInvite | null;
  handleCreateProjectBridgeInvite: () => Promise<void>;
  openProjectSettings: () => void;
  activeConv: Conversation;
  activeConvHasSubtitle: boolean;
  activeLastMessage: Message;
  activeConversationIsBridge: boolean;
  activeBridgeConversationHost: DesktopBridgeHost | null;
  activeBridgeConversation: DesktopBridgeConversation | null;
  activeBridgeAwaitingReply: boolean;
  isBridgePolling: boolean;
  lastBridgePollAtLabel: string | null;
  activeSessionProject: DesktopChatProjectInfo | null;
  showAuthGate: boolean;
  inlineAuthDialog: {
    providerId: string;
    mode: 'oauth' | 'api-key';
    authority?: string;
    requireAuthority?: boolean;
  } | null;
  handleCloseInlineAuthDialog: () => void;
  startWindowResize: (direction: 'left' | 'right' | 'top' | 'bottom' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right') => (event: ReactMouseEvent<HTMLDivElement>) => void;
};

export type SidebarShellArgs = Pick<AssembleKordiShellSlotsArgs,
  | 'isNativeShell'
  | 'isSingleWorkspacePage'
  | 'collapseChatSessions'
  | 'showSessionRail'
  | 'sessionRailWidth'
  | 'activeNav'
  | 'setActiveNav'
  | 'chatConversations'
  | 'handleCreateChatSession'
  | 'chatSearch'
  | 'setChatSearch'
  | 'chatFilter'
  | 'setChatFilter'
  | 'isDesktopChatLoading'
  | 'desktopChatError'
  | 'filteredConversations'
  | 'activeConvId'
  | 'handleSelectChatSession'
  | 'runtimeProjects'
  | 'projectSearch'
  | 'setProjectSearch'
  | 'filteredProjects'
  | 'activeProjectId'
  | 'activeProjectSessionId'
  | 'projectSelectedSessionIds'
  | 'selectProject'
  | 'expandedProjectIds'
  | 'setExpandedProjectIds'
  | 'handleSelectProjectSession'
  | 'groupedContacts'
  | 'displayedContacts'
  | 'setActiveContactGroup'
  | 'setActiveContactId'
  | 'displayedAgents'
  | 'activeBridgeHost'
  | 'refreshDesktopBridge'
  | 'handleCopyBridgeText'
  | 'handleCreateBridgeDraft'
>;

export type MainContentShellArgs = Pick<AssembleKordiShellSlotsArgs,
  | 'activeNav'
  | 'filteredGroupedContacts'
  | 'isContactRequestsOpen'
  | 'setIsContactRequestsOpen'
  | 'contactRequests'
  | 'activeContactRequestId'
  | 'setActiveContactRequestId'
  | 'setContactOverlayMode'
  | 'contactSearch'
  | 'setContactSearch'
  | 'expandedContactGroups'
  | 'setExpandedContactGroups'
  | 'activeContactId'
  | 'setActiveContactGroup'
  | 'setActiveContactId'
  | 'contactOverlayMode'
  | 'activeContact'
  | 'activeContactRequest'
  | 'getStatusBadgeClass'
  | 'handleOpenBridgeConversation'
  | 'displayedAgents'
  | 'activeAgentId'
  | 'activeAgent'
  | 'isAgentOverlayOpen'
  | 'setActiveAgentId'
  | 'setIsAgentOverlayOpen'
  | 'desktopBridgeState'
  | 'activeBridgeHost'
  | 'activeBridgePeople'
  | 'activeBridgeAgents'
  | 'bridgeSettingsDraft'
  | 'setBridgeSettingsDraft'
  | 'isDesktopBridgeSaving'
  | 'desktopBridgeError'
  | 'bridgeWizardOpen'
  | 'setBridgeWizardOpen'
  | 'bridgeWizardStep'
  | 'setBridgeWizardStep'
  | 'bridgeWizardDraft'
  | 'setBridgeWizardDraft'
  | 'handleSelectBridgeHost'
  | 'openBridgeWizard'
  | 'handleCreateBridgeDraft'
  | 'handleStartLocalBridgeHost'
  | 'handleStopLocalBridgeHost'
  | 'refreshDesktopBridge'
  | 'handleSaveBridgeSettings'
  | 'handleRemoveBridgeHost'
  | 'handleCopyBridgeText'
  | 'handleBridgeWizardPrimary'
  | 'settingsRailWidth'
  | 'settingsContentRef'
  | 'activeSettingsSectionId'
  | 'setActiveSettingsSectionId'
  | 'settingsSections'
  | 'activeSettingsSection'
  | 'authSettingsLayoutWidth'
  | 'isNativeShell'
  | 'desktopAuthState'
  | 'isDesktopAuthLoading'
  | 'desktopAuthError'
  | 'activeLoginProviderId'
  | 'selectAuthProvider'
  | 'openLoginFlow'
  | 'refreshDesktopAuth'
  | 'handleSelectAuthChoice'
  | 'handleRemoveAuthProfile'
  | 'handleLogoutProvider'
  | 'projectSettingsDraft'
  | 'isDesktopProjectSaving'
  | 'desktopProjectError'
  | 'handleSaveProjectSettings'
  | 'updateProjectSettingsDraft'
  | 'themeMode'
  | 'setThemeMode'
  | 'collapseChatSessions'
  | 'setIsSessionPanelCollapsed'
  | 'showRightDetailRail'
  | 'isDetailPanelCollapsed'
  | 'setIsDetailPanelCollapsed'
  | 'activeProject'
  | 'activeProjectSession'
  | 'desktopSessionRenameDraft'
  | 'setDesktopSessionRenameDraft'
  | 'isEditingDesktopSessionTitle'
  | 'setIsEditingDesktopSessionTitle'
  | 'handleRenameDesktopSession'
  | 'activeProjectBridgeHost'
  | 'activeProjectBridgeProject'
  | 'chatTranscriptScrollRef'
  | 'onProjectTranscriptScroll'
  | 'setActiveSourcePreview'
  | 'desktopLiveTurn'
  | 'filteredProjectSlashCommands'
  | 'chatSlashMenuIndex'
  | 'setChatSlashMenuIndex'
  | 'acceptProjectSlashCommand'
  | 'chatAttachmentInputRef'
  | 'chatComposerAttachments'
  | 'saveDesktopAttachments'
  | 'removeChatComposerAttachment'
  | 'projectComposerText'
  | 'updateProjectComposerDraft'
  | 'setProjectComposerText'
  | 'composerControlsRef'
  | 'activeRuntimeSessionId'
  | 'activeRuntimeContextStatus'
  | 'activeRuntimeCacheText'
  | 'composerSelectionProject'
  | 'openComposerSelector'
  | 'toggleComposerSelector'
  | 'selectComposerValue'
  | 'composerAuthLabelProject'
  | 'composerAuthOptionsProject'
  | 'selectComposerAuthChoice'
  | 'selectComposerProviderChoice'
  | 'composerProviderOptions'
  | 'chatModelOptions'
  | 'isDesktopChatSending'
  | 'handleStopDesktopChatTurn'
  | 'handleSendProjectMessage'
  | 'showChatDetailRail'
  | 'activeConv'
  | 'activeConversationIsBridge'
  | 'chatTranscriptScrollRef'
  | 'onChatTranscriptScroll'
  | 'filteredChatSlashCommands'
  | 'acceptChatSlashCommand'
  | 'chatComposerText'
  | 'updateChatComposerDraft'
  | 'setChatComposerText'
  | 'composerSelectionChat'
  | 'composerAuthLabelChat'
  | 'composerAuthOptionsChat'
  | 'handleSendChatMessage'
  | 'activeBridgeConversation'
  | 'activeBridgeAwaitingReply'
  | 'lastBridgePollAtLabel'
  | 'isBridgePolling'
>;

export type RightDetailShellArgs = Pick<AssembleKordiShellSlotsArgs,
  | 'isNativeShell'
  | 'activeNav'
  | 'activeDetailTab'
  | 'setActiveDetailTab'
  | 'activeSourcePreview'
  | 'setActiveSourcePreview'
  | 'activeArtifactId'
  | 'setActiveArtifactId'
  | 'activeChatArtifacts'
  | 'activeProjectArtifacts'
  | 'activeProject'
  | 'activeProjectSession'
  | 'activeProjectLastMessage'
  | 'activeProjectBridgeHost'
  | 'activeProjectBridgeProject'
  | 'isProjectBridgeBusy'
  | 'bridgeInvite'
  | 'handleCreateProjectBridgeInvite'
  | 'setActiveNav'
  | 'openProjectSettings'
  | 'getStatusBadgeClass'
  | 'activeConv'
  | 'activeConvHasSubtitle'
  | 'activeLastMessage'
  | 'activeConversationIsBridge'
  | 'activeBridgeConversationHost'
  | 'activeBridgeConversation'
  | 'activeBridgeAwaitingReply'
  | 'isBridgePolling'
  | 'lastBridgePollAtLabel'
  | 'activeSessionProject'
>;

export type OverlayShellArgs = Pick<AssembleKordiShellSlotsArgs,
  | 'showAuthGate'
  | 'windowWidth'
  | 'isNativeShell'
  | 'desktopAuthState'
  | 'isDesktopAuthLoading'
  | 'desktopAuthError'
  | 'activeLoginProviderId'
  | 'selectAuthProvider'
  | 'openLoginFlow'
  | 'refreshDesktopAuth'
  | 'handleSelectAuthChoice'
  | 'handleRemoveAuthProfile'
  | 'handleLogoutProvider'
  | 'inlineAuthDialog'
  | 'handleCloseInlineAuthDialog'
  | 'startWindowResize'
>;

export type KordiShellArgs = {
  sidebar: SidebarShellArgs;
  mainContent: MainContentShellArgs;
  rightDetail: RightDetailShellArgs;
  overlay: OverlayShellArgs;
};
