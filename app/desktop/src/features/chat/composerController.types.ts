import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import type { SettingsSectionId } from '@/kordi-app/data/settings';
import type { SharedCloudAgentSummary } from '@/features/cloud/cloudAgents';
import type { SendCloudGroupControlInput } from '@/features/cloud/useCloudBridgeState';
import type { ComposerDraftState } from './composerDrafts';
import type {
  CanonicalSessionState,
  ComposerQuoteState,
  ComposerScope,
  ComposerSelectorType,
  Conversation,
  ConversationBridgeTarget,
  DesktopBridgeState,
  DesktopChatState,
  DesktopChatTurnSnapshot,
  DetailTab,
  Message,
  MessageAttachment,
  NavId,
  QueuedDesktopChatMessage,
  Project,
} from '@/kordi-app/types';

export type ComposerSelectionState = Record<ComposerScope, { mode: string; model: string; thinking: string }>;
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

export type UseComposerControllerArgs = {
  isNativeShell: boolean;
  activeConversationIsBridge: boolean;
  chatConversations: Conversation[];
  activeConvId: string;
  activeConvCanonicalSessionId?: string | null;
  activeConvMessages: Message[];
  activeConvBridgeTarget?: ConversationBridgeTarget | null;
  activeConvMentionScope?: object & Partial<Pick<Conversation, 'participantSpaceId' | 'canonicalParticipants' | 'participants' | 'directness'>> | null;
  sharedCloudAgents?: SharedCloudAgentSummary[];
  activeProjectId: string;
  activeProjectSessionId: string;
  activeProjectRoot?: string | null;
  selectProjectSession: (projectId: string, sessionId: string) => void;
  desktopChatState: DesktopChatState | null;
  desktopBridgeState: DesktopBridgeState | null;
  canonicalSessionState: CanonicalSessionState | null;
  hasAnyDesktopAuth: boolean;
  canonicalHumanIdentityId?: string | null;
  setCanonicalSessionState: Dispatch<SetStateAction<CanonicalSessionState | null>>;
  desktopLiveTurn: DesktopChatTurnSnapshot | null;
  composerSelections: ComposerSelectionState;
  setComposerSelections: Dispatch<SetStateAction<ComposerSelectionState>>;
  composerDrafts: Record<ComposerScope, string>;
  setComposerDrafts: Dispatch<SetStateAction<ComposerDraftState>>;
  activeChatQuote?: ComposerQuoteState | null;
  setProjectWorkspaces: Dispatch<SetStateAction<Project[]>>;
  setOpenComposerSelector: Dispatch<SetStateAction<ComposerSelectorState>>;
  chatComposerAttachments: AttachmentItem[];
  setChatComposerAttachments: Dispatch<SetStateAction<AttachmentItem[]>>;
  chatModelOptions: MinimalModelOption[];
  preferredModelValueForProvider: (providerId: string) => string | null;
  resolveComposerProviderId: (scope: ComposerScope, modelLabel: string) => string;
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
  setDesktopChatState: Dispatch<SetStateAction<DesktopChatState | null>>;
  setDesktopChatError: Dispatch<SetStateAction<string | null>>;
  isDesktopChatSending: boolean;
  setIsDesktopChatSending: Dispatch<SetStateAction<boolean>>;
  setPendingUserChatMessage: Dispatch<SetStateAction<PendingUserMessage>>;
  queuedDesktopMessagesBySession: Record<string, QueuedDesktopChatMessage[]>;
  setQueuedDesktopMessagesBySession: Dispatch<SetStateAction<Record<string, QueuedDesktopChatMessage[]>>>;
  setDesktopLiveTurnsBySession: Dispatch<SetStateAction<Record<string, DesktopChatTurnSnapshot>>>;
  setDesktopBridgeState: Dispatch<SetStateAction<DesktopBridgeState | null>>;
  setCloudBridgeState?: Dispatch<SetStateAction<DesktopBridgeState | null>>;
  sendCloudBridgeMessage?: (conversationId: string, text: string, attachments?: AttachmentItem[]) => Promise<void>;
  sendCloudGroupControl?: (input: SendCloudGroupControlInput) => Promise<void>;
  cancelCloudBridgeAgentRequest?: (conversationId: string, requestId: string) => Promise<void>;
  watchDesktopLiveTurn: (turn: DesktopChatTurnSnapshot | string) => Promise<void>;
  shouldAutoFollowChatRef: MutableRefObject<boolean>;
  setActiveConvId: Dispatch<SetStateAction<string>>;
};
