import type { Dispatch, MouseEvent as ReactMouseEvent, MutableRefObject, SetStateAction } from 'react';

import type { ComposerAuthOption, ComposerMentionOption, ComposerModelOption, ComposerProviderOption } from '@/kordi-app/components';
import type { SettingsSection, SettingsSectionId } from '@/kordi-app/data/settings';
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
export type BridgeSettingsDraft = {
  hostId?: string | null;
  serverUrl: string;
  displayName: string;
  ownerName: string;
};
export type BridgeWizardDraft = {
  mode: 'have-url' | 'need-host';
  serverUrl: string;
  displayName: string;
  ownerName: string;
};

export type AssembleKordiShellSlotsArgs = {
  isNativeShell: boolean;
  windowWidth: number;
  activeNav: 'chats' | 'contacts' | 'projects' | 'agents' | 'bridge' | 'settings';
  activeConvId: string;
  setActiveConvId: Dispatch<SetStateAction<string>>;
  activeProjectId: string;
  activeProjectSessionId: string;
  activeSettingsSectionId: SettingsSectionId;
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
  refreshDesktopBridge: () => Promise<void>;
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
  activeAgent?: Agent;
  isAgentOverlayOpen: boolean;
  setIsAgentOverlayOpen: Dispatch<SetStateAction<boolean>>;

  desktopBridgeState: DesktopBridgeState | null;
  activeBridgePeople: DesktopBridgePeer[];
  activeBridgeAgents: DesktopBridgePeer[];
  bridgeSettingsDraft: BridgeSettingsDraft | null;
  setBridgeSettingsDraft: Dispatch<SetStateAction<BridgeSettingsDraft | null>>;
  isDesktopBridgeSaving: boolean;
  desktopBridgeError: string | null;
  bridgeWizardOpen: boolean;
  setBridgeWizardOpen: Dispatch<SetStateAction<boolean>>;
  bridgeWizardStep: 1 | 2 | 3;
  setBridgeWizardStep: Dispatch<SetStateAction<1 | 2 | 3>>;
  bridgeWizardDraft: BridgeWizardDraft;
  setBridgeWizardDraft: Dispatch<SetStateAction<BridgeWizardDraft>>;
  handleSelectBridgeHost: (hostId: string) => Promise<void>;
  openBridgeWizard: () => void;
  handleStartLocalBridgeHost: () => void;
  handleStopLocalBridgeHost: () => void;
  handleSaveBridgeSettings: (draftOverride?: BridgeSettingsDraft) => Promise<void>;
  handleRemoveBridgeHost: (hostId: string) => Promise<void>;
  handleOpenBridgeConfigFolder: () => Promise<void>;
  handleRevealBridgeStorageFile: (kind: 'config' | 'conversations' | 'legacy') => Promise<void>;
  handleExportBridgeHostsConfig: () => Promise<void>;
  handleImportBridgeHostsConfig: (raw: string) => Promise<void>;
  handleAddBridgeContact: (hostId: string, peerNodeId: string) => Promise<void>;
  handleSetBridgeDiscoveryMode: (hostId: string, discoveryMode: 'off' | 'contacts' | 'open') => Promise<void>;
  handleCreateBridgeAgent: (hostId: string, label?: string) => Promise<void>;
  handleActivateBridgeAgent: (hostId: string, agentId: string) => Promise<void>;
  handleSetDefaultBridgeAgent: (hostId: string, agentId: string) => Promise<void>;
  handleRemoveBridgeContact: (hostId: string, peerNodeId: string) => Promise<void>;
  handleBridgeWizardPrimary: () => Promise<void>;

  settingsRailWidth: number;
  settingsContentRef: MutableRefObject<HTMLDivElement | null>;
  setActiveSettingsSectionId: Dispatch<SetStateAction<SettingsSectionId>>;
  settingsSections: SettingsSection[];
  activeSettingsSection: SettingsSection;
  authSettingsLayoutWidth: number;
  desktopAuthState: DesktopAuthState | null;
  isDesktopAuthLoading: boolean;
  desktopAuthError: string | null;
  activeLoginProviderId: string | null;
  selectAuthProvider: (providerId: string) => void;
  openAuthSettings: () => void;
  openLoginFlow: (provider: DesktopAuthProvider, mode: 'oauth' | 'api-key', options?: { authority?: string; requireAuthority?: boolean }) => void;
  refreshDesktopAuth: () => Promise<void>;
  handleSelectAuthChoice: (providerId: string, choice: string) => Promise<void>;
  handleRemoveAuthProfile: (providerId: string, profileId: string) => Promise<void>;
  handleLogoutProvider: (providerId: string) => Promise<void>;
  projectSettingsDraft: DesktopProjectSettings | null;
  isDesktopProjectSaving: boolean;
  desktopProjectError: string | null;
  handleSaveProjectSettings: () => Promise<void>;
  updateProjectSettingsDraft: (apply: (current: DesktopProjectSettings) => DesktopProjectSettings) => void;
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
  filteredProjectMentionTargets: ComposerMentionOption[];
  filteredChatMentionTargets: ComposerMentionOption[];
  chatSlashMenuIndex: number;
  setChatSlashMenuIndex: Dispatch<SetStateAction<number>>;
  acceptProjectSlashCommand: (value: string) => void;
  acceptChatSlashCommand: (value: string) => void;
  acceptProjectMentionTarget: (value: string) => void;
  acceptChatMentionTarget: (value: string) => void;
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
  dismissAuthGate: () => void;
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
  | 'setActiveNav'
  | 'chatConversations'
  | 'handleCreateChatSession'
  | 'handleSelectChatSession'
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
  | 'handleCreateBridgeDraft'
  | 'refreshDesktopBridge'
  | 'handleSaveBridgeSettings'
  | 'handleRemoveBridgeHost'
  | 'handleCopyBridgeText'
  | 'handleOpenBridgeConfigFolder'
  | 'handleRevealBridgeStorageFile'
  | 'handleExportBridgeHostsConfig'
  | 'handleImportBridgeHostsConfig'
  | 'handleAddBridgeContact'
  | 'handleSetBridgeDiscoveryMode'
  | 'handleCreateBridgeAgent'
  | 'handleActivateBridgeAgent'
  | 'handleSetDefaultBridgeAgent'
  | 'handleRemoveBridgeContact'
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
  | 'openAuthSettings'
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
  | 'filteredProjectMentionTargets'
  | 'chatSlashMenuIndex'
  | 'setChatSlashMenuIndex'
  | 'acceptProjectSlashCommand'
  | 'acceptProjectMentionTarget'
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
  | 'filteredChatMentionTargets'
  | 'acceptChatSlashCommand'
  | 'acceptChatMentionTarget'
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
  | 'setActiveConvId'
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
  | 'dismissAuthGate'
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
