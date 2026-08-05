import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import type { SettingsSectionId } from '@/kordi-app/data/settings';
import type { SharedCloudAgentSummary } from '@/features/cloud/cloudAgents';
import type {
  SendCloudCollaborationMessageOptions,
  SendCloudGroupControlInput,
} from '@/features/cloud/useCloudCollaborationState';
import type { ComposerDraftState } from './composerDrafts';
import type {
  CanonicalSessionState,
  ComposerQuoteState,
  ComposerScope,
  ComposerSelectorType,
  Conversation,
  ConversationCollaborationTarget,
  DesktopCollaborationState,
  DesktopChatState,
  DesktopChatTurnSnapshot,
  DetailTab,
  Message,
  MessageAttachment,
  NavId,
  QueuedDesktopChatMessage,
  Project,
} from '@/kordi-app/types';

export type ComposerSelection = { mode: string; model: string; thinking: string };
export type ComposerSelectionState = Record<ComposerScope, ComposerSelection>;
export type ComposerConfigTargetOverride = string | null | {
  sessionId: string | null;
  selection: ComposerSelection;
  onSelectionChange: (selection: ComposerSelection) => void;
};
export type { ComposerDraftEntry, ComposerDraftState } from './composerDrafts';
export type ComposerSelectorState = { scope: ComposerScope; type: ComposerSelectorType } | null;
export type AttachmentItem = MessageAttachment & { id: string; path: string };
export type MinimalModelOption = {
  value: string;
  label: string;
  detail?: string | null;
  provider?: string | null;
  providerLabel?: string | null;
  thinkingLevels?: string[];
};
export type MinimalProviderOption = { providerId: string; value: string };
export type PendingUserMessage = { text: string; time: string } | null;

export type ComposerEnvironmentContext = {
  isNativeShell: boolean;
  hasAnyDesktopAuth: boolean;
};

export type ComposerConversationContext = {
  activeConversationUsesCollaboration: boolean;
  chatConversations: Conversation[];
  activeConvId: string;
  activeConvCanonicalSessionId?: string | null;
  activeConvMessages: Message[];
  activeConvCollaborationTarget?: ConversationCollaborationTarget | null;
  activeConvSupportTicketEnabled?: boolean;
  activeConvMentionScope?: object & Partial<Pick<Conversation, 'participantSpaceId' | 'canonicalParticipants' | 'participants' | 'directness'>> | null;
  sharedCloudAgents?: SharedCloudAgentSummary[];
  resolveSharedCloudAgentsForMention?: () => Promise<SharedCloudAgentSummary[]>;
};

export type ComposerProjectContext = {
  activeProjectId: string;
  activeProjectSessionId: string;
  activeProjectRoot?: string | null;
  selectProjectSession: (projectId: string, sessionId: string) => void;
  setProjectWorkspaces: Dispatch<SetStateAction<Project[]>>;
};

export type ComposerRuntimeContext = {
  desktopChatState: DesktopChatState | null;
  desktopCollaborationState: DesktopCollaborationState | null;
  canonicalSessionState: CanonicalSessionState | null;
  canonicalHumanIdentityId?: string | null;
  setCanonicalSessionState: Dispatch<SetStateAction<CanonicalSessionState | null>>;
  desktopLiveTurn: DesktopChatTurnSnapshot | null;
};

export type ComposerDraftContext = {
  composerSelections: ComposerSelectionState;
  setComposerSelections: Dispatch<SetStateAction<ComposerSelectionState>>;
  composerDrafts: Record<ComposerScope, string>;
  setComposerDrafts: Dispatch<SetStateAction<ComposerDraftState>>;
  activeChatQuote?: ComposerQuoteState | null;
  setOpenComposerSelector: Dispatch<SetStateAction<ComposerSelectorState>>;
  chatComposerAttachments: AttachmentItem[];
  setChatComposerAttachments: Dispatch<SetStateAction<AttachmentItem[]>>;
  chatModelOptions: MinimalModelOption[];
  preferredModelValueForProvider: (providerId: string) => string | null;
  resolveComposerProviderId: (scope: ComposerScope, modelLabel: string) => string;
};

export type ComposerAuthNavigationContext = {
  handleSelectAuthChoice: (providerId: string, choice: string) => Promise<void>;
  refreshDesktopAuth: () => Promise<unknown>;
  refreshDesktopChat: (activeSessionId?: string) => Promise<unknown>;
  handleCreateChatSession: () => Promise<void>;
  handleRenameDesktopSession: (fallbackName?: string) => Promise<void>;
  setActiveNav: (nav: NavId) => void;
  setActiveSettingsSectionId: (sectionId: SettingsSectionId) => void;
  setActiveDetailTab: (tab: DetailTab) => void;
  setIsDetailPanelCollapsed: Dispatch<SetStateAction<boolean>>;
  setDesktopSessionRenameDraft: Dispatch<SetStateAction<string>>;
  setIsEditingDesktopSessionTitle: Dispatch<SetStateAction<boolean>>;
};

export type ComposerMessageRuntimeContext = {
  setDesktopChatState: Dispatch<SetStateAction<DesktopChatState | null>>;
  setDesktopChatError: Dispatch<SetStateAction<string | null>>;
  isDesktopChatSending: boolean;
  setIsDesktopChatSending: Dispatch<SetStateAction<boolean>>;
  setPendingUserChatMessage: Dispatch<SetStateAction<PendingUserMessage>>;
  queuedDesktopMessagesBySession: Record<string, QueuedDesktopChatMessage[]>;
  setQueuedDesktopMessagesBySession: Dispatch<SetStateAction<Record<string, QueuedDesktopChatMessage[]>>>;
  setDesktopLiveTurnsBySession: Dispatch<SetStateAction<Record<string, DesktopChatTurnSnapshot>>>;
  setCloudCollaborationState?: Dispatch<SetStateAction<DesktopCollaborationState | null>>;
  sendCloudCollaborationMessage?: (
    conversationId: string,
    text: string,
    attachments?: AttachmentItem[],
    options?: SendCloudCollaborationMessageOptions,
  ) => Promise<void>;
  sendCloudGroupControl?: (input: SendCloudGroupControlInput) => Promise<void>;
  cancelCloudAgentRequest?: (conversationId: string, requestId: string) => Promise<void>;
  watchDesktopLiveTurn: (turn: DesktopChatTurnSnapshot | string) => Promise<void>;
  shouldAutoFollowChatRef: MutableRefObject<boolean>;
  setActiveConvId: Dispatch<SetStateAction<string>>;
};

export type UseComposerControllerArgs = {
  environment: ComposerEnvironmentContext;
  conversation: ComposerConversationContext;
  project: ComposerProjectContext;
  runtime: ComposerRuntimeContext;
  draft: ComposerDraftContext;
  authNavigation: ComposerAuthNavigationContext;
  messageRuntime: ComposerMessageRuntimeContext;
};

export type UseComposerInputActionsArgs = {
  environment: Pick<ComposerEnvironmentContext, 'isNativeShell'>;
  conversation: Pick<
    ComposerConversationContext,
    'activeConvId' | 'activeConvCanonicalSessionId'
  >;
  project: Pick<ComposerProjectContext, 'activeProjectSessionId'>;
  runtime: Pick<ComposerRuntimeContext, 'desktopChatState'>;
  draft: Pick<
    ComposerDraftContext,
    | 'composerSelections'
    | 'setComposerSelections'
    | 'setComposerDrafts'
    | 'setOpenComposerSelector'
    | 'chatComposerAttachments'
    | 'setChatComposerAttachments'
    | 'chatModelOptions'
    | 'preferredModelValueForProvider'
    | 'resolveComposerProviderId'
  >;
  authNavigation: Pick<
    ComposerAuthNavigationContext,
    'handleSelectAuthChoice' | 'refreshDesktopChat'
  >;
  messageRuntime: Pick<
    ComposerMessageRuntimeContext,
    'setDesktopChatState' | 'setDesktopChatError' | 'shouldAutoFollowChatRef'
  >;
};
