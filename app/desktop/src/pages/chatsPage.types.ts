import type {
  ComponentProps,
  Dispatch,
  MouseEventHandler,
  ReactNode,
  RefObject,
  SetStateAction,
} from 'react';

import type { CloudAccount, CloudSessionPin } from '@/features/cloud/authClient';
import type { CloudSelfAgentSyncStatus } from '@/features/cloud/useCloudCollaborationState';
import type { ComposerConfigTargetOverride } from '@/features/chat/composerController.types';
import type {
  ComposerAuthOption,
  ComposerMentionOption,
  ComposerModelOption,
  ComposerProviderOption,
  MessageBubble,
} from '@/kordi-app/components';
import type {
  ComposerQuoteState,
  Contact,
  Conversation,
  DesktopCollaborationHost,
  DesktopChatContextWindowStatus,
  DesktopChatSlashCommand,
  DesktopChatState,
  DesktopChatTurnSnapshot,
  DetailTab,
  EditFilePreview,
  Message,
  MessageSourceReference,
  QueuedDesktopChatMessage,
} from '@/kordi-app/types';
import type { TranscriptDensityMode } from '@/kordi-app/components/transcript';
import type { VirtualTranscriptNavigationRequest } from '@/features/chat/VirtualTranscript';
import type { DesktopChatContextMessage } from '@/lib/desktop';

export type ChatAttachment = {
  id: string;
  name: string;
  path: string;
  kind: 'image' | 'file';
};

export type ChatsPageLayout = {
  isNativeShell: boolean;
  showChatDetailRail: boolean;
  collapseChatSessions: boolean;
  setIsSessionPanelCollapsed: Dispatch<SetStateAction<boolean>>;
  showRightDetailRail: boolean;
  isDetailPanelCollapsed: boolean;
  setIsDetailPanelCollapsed: Dispatch<SetStateAction<boolean>>;
  rightDetailRail?: ReactNode;
  detailRailWidth?: number;
  activeDetailTab: DetailTab;
  setActiveDetailTab: Dispatch<SetStateAction<DetailTab>>;
  activeArtifactId: string | null;
  setActiveArtifactId: Dispatch<SetStateAction<string | null>>;
  onDetailResizeMouseDown?: MouseEventHandler<HTMLDivElement>;
};

export type ChatsPageSession = {
  activeConv: Conversation;
  chatConversations: Conversation[];
  activeConversationUsesCollaboration: boolean;
  activeCollaborationModelHost: DesktopCollaborationHost | null;
  desktopChatState: DesktopChatState | null;
  cloudSelfAgentSyncStatus?: CloudSelfAgentSyncStatus | null;
  cloudAccount?: CloudAccount | null;
  cloudSessionPin?: CloudSessionPin | null;
  onUpdateCloudSessionPin?: (input: {
    sessionId: string;
    messageId: string | null;
    scope: 'private' | 'shared';
  }) => Promise<CloudSessionPin>;
  onUpdateCollaborationAgentModelRouting: (
    hostId: string,
    agentId: string,
    defaultModel?: string | null,
    fallbackModel?: string | null,
    thinking?: string | null,
    defaultAuthProvider?: string | null,
    defaultAuthChoice?: string | null,
    fallbackAuthProvider?: string | null,
    fallbackAuthChoice?: string | null,
    targetSessionIdOverride?: string | null,
  ) => Promise<void>;
  isEditingDesktopSessionTitle: boolean;
  setIsEditingDesktopSessionTitle: Dispatch<SetStateAction<boolean>>;
  desktopSessionRenameDraft: string;
  setDesktopSessionRenameDraft: Dispatch<SetStateAction<string>>;
  onRenameDesktopSession: (baselineName: string) => Promise<void>;
  onRenameChatSession: (sessionId: string, title: string) => Promise<void>;
};

export type ChatsPageTranscript = {
  chatTranscriptScrollRef: RefObject<HTMLDivElement | null>;
  canonicalHasOlderBySessionId?: Record<string, boolean>;
  onLoadOlderCanonicalSessionMessages?: (sessionId: string) => Promise<void>;
  onTranscriptScroll: () => void;
  onOpenSource: (file: EditFilePreview) => void;
  onClearSourcePreview?: () => void;
  onOpenArtifact: (artifactId: string) => void;
  desktopLiveTurn: DesktopChatTurnSnapshot | null;
  queuedDesktopMessages: QueuedDesktopChatMessage[];
  queuedDesktopMessagesBySession: Record<string, QueuedDesktopChatMessage[]>;
  onEditQueuedMessage: (sessionId: string, queuedMessageId: string) => void;
  onCancelQueuedMessage: (sessionId: string, queuedMessageId: string) => void;
};

export type ChatsPageComposer = {
  filteredChatSlashCommands: DesktopChatSlashCommand[];
  filteredChatMentionTargets: ComposerMentionOption[];
  chatSlashMenuIndex: number;
  setChatSlashMenuIndex: Dispatch<SetStateAction<number>>;
  acceptChatSlashCommand: (value: string) => void;
  acceptChatMentionTarget: (value: string) => void;
  chatAttachmentInputRef: RefObject<HTMLInputElement | null>;
  chatComposerAttachments: ChatAttachment[];
  saveDesktopAttachments: (files: File[]) => Promise<ChatAttachment[]>;
  saveDesktopAttachmentPaths: (paths: string[]) => Promise<ChatAttachment[]>;
  removeChatComposerAttachment: (id: string) => void;
  chatComposerText: string;
  updateChatComposerDraft: (
    value: string,
    target: HTMLTextAreaElement,
  ) => void;
  setChatComposerText: (value: string) => void;
  setChatComposerTextForSession: (sessionId: string, value: string) => void;
  activeChatQuote?: ComposerQuoteState | null;
  onClearChatQuote?: () => void;
  onReplyMessage?: (message: Message) => void;
  onForwardMessage?: (message: Message) => void;
  onSelectMessage?: (message: Message) => void;
  messageSelectionMode?: boolean;
  selectedMessageCount?: number;
  selectedMessageIds?: ReadonlySet<string>;
  isMessageSelectable?: (message: Message) => boolean;
  onToggleSelectedMessage?: (message: Message) => void;
  onSelectionDragStart?: (message: Message, shouldSelect: boolean) => void;
  onSelectionDragEnter?: (message: Message) => void;
  onSelectionDragEnd?: () => void;
  onCancelMessageSelection?: () => void;
  onCopySelectedMessages?: () => void;
  onForwardSelectedMessages?: () => void;
};

export type ChatsPageRuntime = {
  composerControlsRef: RefObject<HTMLDivElement | null>;
  activeRuntimeContextStatus?: DesktopChatContextWindowStatus | null;
  activeRuntimeCacheText?: string | null;
  composerSelection: { mode: string; model: string; thinking: string };
  openComposerSelector: {
    scope: 'chat' | 'project';
    type: 'mode' | 'auth' | 'provider' | 'model' | 'thinking';
  } | null;
  toggleComposerSelector: (
    scope: 'chat' | 'project',
    type: 'mode' | 'auth' | 'provider' | 'model' | 'thinking',
  ) => void;
  selectComposerValue: (
    scope: 'chat' | 'project',
    type: 'mode' | 'auth' | 'provider' | 'model' | 'thinking',
    value: string,
    configTargetOverride?: ComposerConfigTargetOverride,
  ) => void;
  composerAuthLabel: string;
  composerAuthOptions: ComposerAuthOption[];
  selectComposerAuthChoice: (
    scope: 'chat' | 'project',
    providerId: string,
    choice: string,
    configTargetOverride?: ComposerConfigTargetOverride,
  ) => void;
  selectComposerProviderChoice: (
    scope: 'chat' | 'project',
    option: ComposerProviderOption,
    configTargetOverride?: ComposerConfigTargetOverride,
  ) => void;
  composerProviderOptions: ComposerProviderOption[];
  chatModelOptions?: ComposerModelOption[];
  isDesktopChatSending: boolean;
  onStopDesktopChatTurn: () => void;
  onStopCollaborationAgentRequest: NonNullable<
    ComponentProps<typeof MessageBubble>['onStopCollaborationAgentRequest']
  >;
  onRequestCollaborationContact?: ComponentProps<
    typeof MessageBubble
  >['onRequestCollaborationContact'];
  onMessageContact?: (contact: Contact) => Promise<void> | void;
  onForkChatMessage?: (
    sessionId: string,
    messageEntryId: string,
  ) => Promise<void>;
  onRetryChatMessage?: (message: Message) => void;
  onSelectSession?: (sessionId: string) => void;
  onSendChatMessage: (
    draftOverride?: string,
    targetSessionId?: string,
    contextMessages?: DesktopChatContextMessage[],
  ) => void;
  onCreateAgentSession?: () => string | null | Promise<string | null>;
};

export type ChatsPageAuth = {
  hasAnyAuth: boolean;
  onOpenAuthSettings: () => void;
  onOpenAccountAuthentication?: () => void;
};

export type ChatsPageProps = {
  layout: ChatsPageLayout;
  session: ChatsPageSession;
  transcript: ChatsPageTranscript;
  composer: ChatsPageComposer;
  runtime: ChatsPageRuntime;
  auth: ChatsPageAuth;
};

export type ChatSessionPaneViewport = {
  sessionKey: string;
  messages: readonly Message[];
  scrollRef: RefObject<HTMLDivElement | null>;
  scrollClassName: string;
  onTranscriptScroll?: () => void;
  hasOlderMessages?: boolean;
  onLoadOlderMessages?: () => Promise<void> | void;
  navigationRequest?: VirtualTranscriptNavigationRequest | null;
  onNavigationHandled?: (request: VirtualTranscriptNavigationRequest) => void;
  emptyState?: ReactNode;
  composer: ReactNode;
  queuedMessages?: QueuedDesktopChatMessage[];
  onEditQueuedMessage?: (sessionId: string, queuedMessageId: string) => void;
  onCancelQueuedMessage?: (sessionId: string, queuedMessageId: string) => void;
};

export type ChatSessionPanePresentation = {
  liveTurn?: DesktopChatTurnSnapshot | null;
  liveTurnSender: string;
  shouldRenderLiveTurn: boolean;
  isCompressionActive?: boolean;
  plainAgentResponse?: boolean;
  inferLatestHumanReplyTarget?: boolean;
  forkSnapshotBoundaryIndex?: number;
  activeForkSourceSessionId?: string | null;
  activeForkSourceTitle?: string | null;
  messageForksByEntryId?: Map<
    string,
    Array<{ sessionId: string; title: string; updatedAtLabel?: string }>
  >;
  pinnedMessageId?: string | null;
  densityMode?: TranscriptDensityMode;
};

export type ChatSessionPaneActions = {
  onSelectSession?: (sessionId: string) => void;
  onOpenSource: (file: EditFilePreview) => void;
  onOpenArtifact: (artifactId: string) => void;
  onOpenAuthSettings: () => void;
  onNavigateToMessage?: (
    messageId: string,
    sourceMessage?: MessageSourceReference,
  ) => void;
  onOpenMessageDetail?: (message: Message) => void;
  onStopCollaborationAgentRequest: NonNullable<
    ComponentProps<typeof MessageBubble>['onStopCollaborationAgentRequest']
  >;
  onStopActiveTurn?: () => void;
  onRequestCollaborationContact?: ComponentProps<
    typeof MessageBubble
  >['onRequestCollaborationContact'];
  onOpenSenderProfile?: ComponentProps<
    typeof MessageBubble
  >['onOpenSenderProfile'];
  onForkMessage?: (entryId: string) => void;
  onOpenForkSession?: (sessionId: string) => void;
  onReplyMessage?: (message: Message) => void;
  onForwardMessage?: (message: Message) => void;
  onRetryMessage?: (message: Message) => void;
  onSelectMessage?: (message: Message) => void;
  onRequestPinMessage?: (message: Message) => void;
  onRequestUnpinMessage?: (message: Message) => void;
};

export type ChatSessionPaneSelection = {
  selectionMode?: boolean;
  selectedMessageIds?: ReadonlySet<string>;
  isMessageSelectable?: (message: Message) => boolean;
  onToggleSelectedMessage?: (message: Message) => void;
  onSelectionDragStart?: (message: Message, shouldSelect: boolean) => void;
  onSelectionDragEnter?: (message: Message) => void;
  onSelectionDragEnd?: () => void;
  selectedMessageCount?: number;
  onCancelMessageSelection?: () => void;
  onCopySelectedMessages?: () => void;
  onForwardSelectedMessages?: () => void;
  messageSelectionMode?: boolean;
};

export type ChatSessionPaneProps = {
  viewport: ChatSessionPaneViewport;
  presentation: ChatSessionPanePresentation;
  actions: ChatSessionPaneActions;
  selection: ChatSessionPaneSelection;
};
