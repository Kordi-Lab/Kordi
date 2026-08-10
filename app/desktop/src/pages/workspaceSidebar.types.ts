import type { Dispatch, SetStateAction } from 'react';

import type { CreateChatGroupRequest } from '@/app/kordiShellSlots.types';
import type {
  CloudAccount,
  CloudGroupInvitation,
  CloudGroupInvitationCreateInput,
  CloudGroupInvitationSummary,
} from '@/features/cloud/authClient';
import type { DesktopUpdaterState } from '@/features/updates/desktopUpdater';
import type {
  Agent,
  ChatChannel,
  Contact,
  ContactClass,
  ConversationType,
  NavId,
  ParticipantSpaceViewModel,
  SessionStatusIndicator,
} from '@/kordi-app/types';
import type {
  CloudAccountSettingsConfig,
  CloudAccountSettingsTabId,
} from '@/pages/CloudAccountSettingsDialog';
import type { AddContactLookupResult } from '@/pages/ChatCreateDialog';

export type WorkspaceSidebarConversation = {
  id: string;
  canonicalSessionId?: string;
  name: string;
  subtitle: string;
  unread: number;
  messages: Array<{ time?: string }>;
  participants?: string[];
  updatedAtLabel?: string;
  statusIndicator?: SessionStatusIndicator;
  type?: ConversationType;
  profileImageUrl?: string | null;
  avatarSeed?: string | null;
  forkedFromSessionId?: string | null;
  forkedFromMessageId?: string | null;
};

export type WorkspaceSidebarParticipantSpace = ParticipantSpaceViewModel;

export type WorkspaceSidebarProject = {
  id: string;
  name: string;
  root?: string;
  sessions: Array<{
    id: string;
    name: string;
    summary?: string;
    lastActive: string;
    unread?: number;
    statusIndicator?: SessionStatusIndicator;
  }>;
};

export type WorkspaceSidebarLayout = {
  isNativeShell: boolean;
  isSingleWorkspacePage: boolean;
  collapseChatSessions: boolean;
  showSessionRail: boolean;
  sessionRailWidth: number;
  activeNav: NavId;
  setActiveNav: Dispatch<SetStateAction<NavId>>;
  onCheckForUpdates?: () => Promise<DesktopUpdaterState>;
  onInstallUpdate?: () => Promise<void>;
  onRetryUpdate?: () => Promise<void | DesktopUpdaterState>;
  onSubscribeToUpdate?: (listener: (state: DesktopUpdaterState) => void) => () => void;
  onOpenUpdateUrl?: (url: string) => Promise<void> | void;
};

export type WorkspaceSidebarChats = {
  chatConversations: WorkspaceSidebarConversation[];
  onCreateChatSession: () => void;
  chatSearch: string;
  setChatSearch: Dispatch<SetStateAction<string>>;
  isDesktopChatLoading: boolean;
  desktopChatError: string | null;
  participantSpaces: WorkspaceSidebarParticipantSpace[];
  contactParticipantSpaces: WorkspaceSidebarParticipantSpace[];
  agentParticipantSpaces: WorkspaceSidebarParticipantSpace[];
  initialSelectedParticipantSpaceId?: string | null;
  initialChatChannel?: ChatChannel;
  activeConvId: string;
  onPrefetchChatSession?: (sessionId: string) => void;
  onSelectChatSession: (sessionId: string) => void;
  onStartChatWithPerson: (contact: Contact) => Promise<void> | void;
  onStartChatWithAgent: (agent: Agent) => Promise<void> | void;
  onCreateChatGroup: (request: CreateChatGroupRequest) => Promise<void> | void;
  onAddContactByNodeId: (nodeId: string) => Promise<void> | void;
  onLookupContact?: (idOrEmail: string) => Promise<AddContactLookupResult | null>;
  addContactPlaceholder?: string;
  onCreateChatSessionInParticipantSpace: (
    space: WorkspaceSidebarParticipantSpace,
  ) => Promise<void> | void;
  onRenameChatGroup: (sessionIds: string[], name: string) => Promise<void> | void;
  onRenameChatSession: (sessionId: string, title: string) => void;
  onAddChatGroupMembers: (sessionIds: string[], contactIds: string[]) => Promise<void> | void;
  onRemoveChatGroupMember: (
    sessionIds: string[],
    identityId: string,
  ) => Promise<void> | void;
  onSetChatGroupAdmin: (
    sessionIds: string[],
    identityId: string,
    isAdmin: boolean,
  ) => Promise<void> | void;
  onDeleteChatSession: (sessionId: string) => void | Promise<void>;
  isCollaborationSyncing: boolean;
  isCollaborationSyncUnavailable?: boolean;
};

export type WorkspaceSidebarProjects = {
  onCreateProjectFromFolder: (folderPath: string, name?: string) => Promise<void> | void;
  onCreateProject: (name: string, parentDir?: string) => Promise<void> | void;
  runtimeProjects: WorkspaceSidebarProject[];
  projectSearch: string;
  setProjectSearch: Dispatch<SetStateAction<string>>;
  filteredProjects: WorkspaceSidebarProject[];
  activeProjectId: string;
  activeProjectSessionId: string;
  projectSelectedSessionIds: Record<string, string>;
  selectProject: (projectId: string, sessionId?: string) => void;
  expandedProjectIds: Record<string, boolean>;
  setExpandedProjectIds: Dispatch<SetStateAction<Record<string, boolean>>>;
  onSelectProjectSession: (projectId: string, sessionId: string) => void;
};

export type WorkspaceSidebarDirectory = {
  groupedContacts: Array<{ id: ContactClass; label: string; items: Contact[] }>;
  displayedContacts: Contact[];
  addableContacts: Contact[];
  contactRequestCount: number;
  setActiveContactGroup: Dispatch<SetStateAction<ContactClass>>;
  setActiveContactId: Dispatch<SetStateAction<string>>;
  displayedAgents: Agent[];
};

export type WorkspaceSidebarAccount = {
  localProfileAvatarSeed?: string | null;
  cloudAccount?: CloudAccount | null;
  cloudAccountDialogTab?: CloudAccountSettingsTabId | null;
  setCloudAccountDialogTab?: Dispatch<SetStateAction<CloudAccountSettingsTabId | null>>;
  cloudSettings?: CloudAccountSettingsConfig;
  onUpdateCloudProfile?: (input: { displayName?: string; avatarUrl?: string }) => Promise<void>;
  onCloudSignOut?: () => Promise<void> | void;
  onCreateAppInvite?: () => Promise<string>;
  onCreateGroupInvite?: (
    input: CloudGroupInvitationCreateInput,
  ) => Promise<CloudGroupInvitation>;
  onListGroupInvites?: (groupSpaceId: string) => Promise<CloudGroupInvitationSummary[]>;
  onRevokeGroupInvite?: (invitationId: string) => Promise<void>;
};

export type WorkspaceSidebarProps = {
  layout: WorkspaceSidebarLayout;
  chats: WorkspaceSidebarChats;
  projects: WorkspaceSidebarProjects;
  directory: WorkspaceSidebarDirectory;
  account: WorkspaceSidebarAccount;
};
