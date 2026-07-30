import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, DragEvent, PointerEvent as ReactPointerEvent, SetStateAction } from 'react';
import { useReducedMotion } from 'framer-motion';
import {
  Cloud,
  Columns2,
  GripVertical,
  PanelLeftClose,
  PanelLeftOpen,
  Split,
} from 'lucide-react';

import { AuthNoticeBanner } from '@/components/AuthNoticeBanner';
import {
  collaborationAgentRoutingChangeNotice,
  collaborationChatRoutingControlVisibility,
  localOwnedCollaborationAgentsForModelRouting,
  resolveCollaborationAgentRoutingUpdate,
  routingSelectionForCollaborationAgent,
  type LocalCollaborationAgentRoutingOption,
} from '@/features/collaboration/agentModelRouting';
import { isCloudCollaborationConversationId, isCloudCollaborationHostId } from '@/features/cloud/cloudCollaborationState';
import type { CloudSelfAgentSyncStatus } from '@/features/cloud/useCloudCollaborationState';
import type { CloudSessionPin } from '@/features/cloud/authClient';
import { useCloudContacts } from '@/features/cloud/useCloudContacts';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { localOwnedAgentSenderLabel, suppressLiveTurnEchoMessages } from '@/app/viewModels/helpers';
import {
  fallbackComposerThinkingValue,
  type ComposerModelOption,
  type ComposerProviderOption,
  type CompactComposerModelMenuSaveInput,
} from '@/kordi-app/components';
import type {
  Contact,
  Conversation,
  ConversationParticipant,
  DesktopCollaborationAgentRouting,
  DesktopCollaborationHost,
  EditFilePreview,
  Message,
  MessageSourceReference,
} from '@/kordi-app/types';
import { chatComposerPlaceholder } from '@/features/chat/composerCopy';
import { shouldInferLatestHumanReplyTarget, shouldSuppressAgentReplyAttribution } from '@/features/chat/replyAttribution';
import {
  CHAT_COMPOSER_TEXTAREA_SELECTOR,
  focusComposerTextarea,
} from '@/features/chat/composerController.shared';
import { collapseAdjacentSessionConfigNotices } from '@/features/chat/sessionConfigNotices';
import { resolveTranscriptMessageIdForSource } from '@/features/chat/messageNavigation';
import type { TranscriptDensityMode } from '@/kordi-app/components/transcript';
import { LOCAL_DRAFT_CHAT_CONVERSATION_ID } from '@/features/chat/draftSessions';
import { buildForkLineage, isGroupForkSession, isGroupSessionId } from '@/features/chat/forkLineage';
import { useCompanionComposerRuntime } from '@/features/chat/useCompanionComposerRuntime';
import type { DesktopChatContextMessage } from '@/lib/desktop';
import { cn } from '@/lib/utils';
import { MemberContactProfilePopover } from '@/pages/MemberContactProfilePopover';
import type {
  ChatAttachment as Attachment,
  ChatsPageProps,
} from '@/pages/chatsPage.types';
import { CompanionComposer } from '@/pages/chatsPage.companionComposer';
import { CompanionDestinationPage } from '@/pages/chatsPage.companionDestination';
import {
  COLLABORATION_ROUTING_NOTICE_AUTO_DISMISS_MS,
  COLLABORATION_ROUTING_NOTICE_EXIT_MS,
} from '@/pages/chatsPage.constants';
import { CompanionHeader } from '@/pages/chatsPage.companionHeader';
import { CompanionPane } from '@/pages/chatsPage.companionPane';
import { MainComposer } from '@/pages/chatsPage.mainComposer';
import { MainChatHeader } from '@/pages/chatsPage.mainHeader';
import {
  SessionDestinationTabs,
} from '@/pages/chatsPage.destinations';
import {
  CHAT_DETAIL_TABS,
  detailDestinationFromTab,
} from '@/pages/chatsPage.destinationModel';
import type {
  ChatDestination,
  ChatDetailDestination,
} from '@/pages/chatsPage.destinationModel';
import {
  chatHeaderSubtitle,
  cloudSelfAgentSyncStatusLabel,
  localAgentComposerConfigTargetSessionId,
  scheduleTranscriptScrollToBottom,
  selfAgentSessionIdForTitleRename,
} from '@/pages/chatsPage.header';
import {
  PinMessageDialog,
  PinnedMessageBar,
} from '@/pages/chatsPage.pins';
import {
  chatMessageActionId,
  pinnedMessageCandidateIds,
  stableCloudPinMessageId,
} from '@/pages/chatsPage.pinModel';
import {
  ChatComposerShell,
  ChatSessionPane,
  SessionStartingState,
} from '@/pages/chatsPage.sessionPane';
import {
  sameTranscriptNavigationRequest,
} from '@/pages/chatsPage.navigation';
import type { TranscriptNavigationRequest } from '@/pages/chatsPage.navigation';
import {
  CHAT_COMPANION_DRAG_TYPE,
  authChoiceFromProviderOption,
  buildAskAgentSessionReferenceContext,
  buildAskAgentSessionReferenceContextMessage,
  canonicalHistorySessionIdForConversation,
  chatCompanionCandidates,
  chatCompanionSideForPaneKinds,
  chatCompanionSideFromDropPosition,
  chatSideAgentConversationForOpenRequest,
  chatTranscriptDensityMode,
  clampChatSplitFraction,
  collaborationRouteDisplayName,
  collaborationThinkingDisplayName,
  conversationPaneKind,
  forkSnapshotBoundaryIndexForMessages,
  forkSourceMessageIds,
  humanSideForCompanionSide,
  pairedCompanionConversation,
  parseAskAgentTriggerCommand,
  transcriptHumanParticipant,
} from '@/pages/chatsPage.model';
import type { CompanionSide } from '@/pages/chatsPage.model';

export {
  chatHeaderSubtitle,
  cloudSelfAgentSyncStatusLabel,
  isGenericChatHeaderSubtitle,
  localAgentComposerConfigTargetSessionId,
  selfAgentSessionIdForTitleRename,
  shouldUseCompactModelRouteMenu,
} from '@/pages/chatsPage.header';
export {
  PinMessageDialog,
  PinnedMessageBar,
} from '@/pages/chatsPage.pins';
export {
  buildAskAgentSessionReferenceContext,
  buildAskAgentSessionReferenceContextMessage,
  canonicalHistorySessionIdForConversation,
  chatCompanionCandidates,
  chatCompanionSideForPaneKinds,
  chatCompanionSideFromDropPosition,
  chatComposerSubmitMode,
  chatSideAgentConversationForOpenRequest,
  forkSnapshotBoundaryIndexForMessages,
  forkSourceMessageIds,
  humanSideForCompanionSide,
  pairedCompanionConversation,
  parseAskAgentTriggerCommand,
  transcriptHumanParticipant,
} from '@/pages/chatsPage.model';

export {
  COLLABORATION_ROUTING_NOTICE_AUTO_DISMISS_MS,
  COLLABORATION_ROUTING_NOTICE_EXIT_MS,
} from '@/pages/chatsPage.constants';

export function ChatsPage({
  layout,
  session,
  transcript,
  composer,
  runtime,
  auth,
}: ChatsPageProps) {
  const {
    isNativeShell,
    showChatDetailRail,
    collapseChatSessions,
    setIsSessionPanelCollapsed,
    showRightDetailRail,
    isDetailPanelCollapsed,
    setIsDetailPanelCollapsed,
    rightDetailRail,
    activeDetailTab,
    setActiveDetailTab,
  } = layout;
  const {
    activeConv,
    chatConversations,
    activeConversationUsesCollaboration,
    activeCollaborationModelHost,
    desktopChatState,
    cloudSelfAgentSyncStatus,
    cloudAccount = null,
    cloudSessionPin,
    onUpdateCloudSessionPin,
    onUpdateCollaborationAgentModelRouting,
    isEditingDesktopSessionTitle,
    setIsEditingDesktopSessionTitle,
    desktopSessionRenameDraft,
    setDesktopSessionRenameDraft,
    onRenameDesktopSession,
    onRenameChatSession,
  } = session;
  const {
    chatTranscriptScrollRef,
    canonicalHasOlderBySessionId = {},
    onLoadOlderCanonicalSessionMessages,
    onTranscriptScroll,
    onOpenSource,
    onClearSourcePreview,
    onOpenArtifact,
    desktopLiveTurn,
    queuedDesktopMessages,
    queuedDesktopMessagesBySession,
    onEditQueuedMessage,
    onCancelQueuedMessage,
  } = transcript;
  const {
    chatComposerAttachments,
    saveDesktopAttachments,
    saveDesktopAttachmentPaths,
    removeChatComposerAttachment,
    chatComposerText,
    setChatComposerText,
    setChatComposerTextForSession,
    activeChatQuote,
    onReplyMessage,
    onForwardMessage,
    onSelectMessage,
    messageSelectionMode = false,
    selectedMessageIds,
    isMessageSelectable,
    onToggleSelectedMessage,
    onSelectionDragStart,
    onSelectionDragEnter,
    onSelectionDragEnd,
  } = composer;
  const {
    activeRuntimeContextStatus,
    activeRuntimeCacheText,
    composerSelection,
    openComposerSelector,
    toggleComposerSelector,
    selectComposerValue,
    composerAuthOptions,
    selectComposerProviderChoice,
    composerProviderOptions,
    chatModelOptions,
    isDesktopChatSending,
    onStopDesktopChatTurn,
    onStopCollaborationAgentRequest,
    onRequestCollaborationContact,
    onMessageContact,
    onForkChatMessage,
    onRetryChatMessage,
    onSelectSession,
    onSendChatMessage,
    onCreateAgentSession,
  } = runtime;
  const {
    hasAnyAuth,
    onOpenAuthSettings,
    onOpenAccountAuthentication,
  } = auth;
  const cloudContacts = useCloudContacts(cloudAccount);
  const [senderProfileTarget, setSenderProfileTarget] = useState<{
    participant: ConversationParticipant;
    anchorRect: DOMRect;
  } | null>(null);
  const openAuthentication = onOpenAccountAuthentication ?? onOpenAuthSettings;
  const authNoticeDescription = onOpenAccountAuthentication
    ? 'Connect a provider, save an API key, or choose a local LM Studio/Ollama server before starting AI chats.'
    : 'Connect a cloud provider, save an API key, or choose a local LM Studio/Ollama server in Authentication before starting AI chats.';
  const authNoticeActionLabel = 'Open authentication';
  const visibleDesktopLiveTurn = desktopLiveTurn ?? (!isNativeShell ? activeConv.previewLiveTurn ?? null : null);
  const isCompressionActive = visibleDesktopLiveTurn?.status === 'compacting';
  const activeLiveTurnIsRunning = Boolean(
    desktopLiveTurn && desktopLiveTurn.sessionId === activeConv.id && !desktopLiveTurn.completed,
  );
  const activeSessionSubtitle = chatHeaderSubtitle(activeConv);
  const activeCloudSelfAgentSyncLabel = cloudSelfAgentSyncStatusLabel(cloudSelfAgentSyncStatus);
  const activeSelfAgentSessionId = selfAgentSessionIdForTitleRename(activeConv);
  const activeSelfAgentSessionIsDraft = activeConv.id === LOCAL_DRAFT_CHAT_CONVERSATION_ID
    || activeConv.canonicalSessionId === LOCAL_DRAFT_CHAT_CONVERSATION_ID;
  const activeSelfAgentSessionIsStarting = activeSelfAgentSessionIsDraft && isDesktopChatSending;
  const canRenameActiveSelfAgentSession = isNativeShell
    && activeConv.type === 'owned-agent'
    && (Boolean(activeSelfAgentSessionId) || activeSelfAgentSessionIsDraft)
    && !activeSelfAgentSessionIsStarting;
  const activeTranscriptLiveTurn = visibleDesktopLiveTurn?.sessionId === activeConv.id ? visibleDesktopLiveTurn : undefined;
  const chatComposerPlaceholderText = chatComposerPlaceholder(activeConv);
  const liveTurnSender = localOwnedAgentSenderLabel(activeConv);
  const [selectedCollaborationAgentId, setSelectedCollaborationAgentId] = useState<string | null>(null);
  const [selectedCompanionCollaborationAgentId, setSelectedCompanionCollaborationAgentId] = useState<string | null>(null);
  const [collaborationRoutingNotice, setCollaborationRoutingNotice] = useState<string | null>(null);
  const [companionCollaborationRoutingNotice, setCompanionCollaborationRoutingNotice] = useState<string | null>(null);
  const [optimisticCollaborationAgentRouting, setOptimisticCollaborationAgentRouting] = useState<
    Record<string, DesktopCollaborationAgentRouting>
  >({});
  const [humanPaneSide, setHumanPaneSide] = useState<CompanionSide>('left');
  const [selectedCompanionConversationId, setSelectedCompanionConversationId] = useState<string | null>(null);
  const [openSideAgentConversationId, setOpenSideAgentConversationId] = useState<string | null>(null);
  const [sideAgentReferenceContext, setSideAgentReferenceContext] = useState<string | null>(null);
  const [isSideAgentActionsOpen, setIsSideAgentActionsOpen] = useState(false);
  const [isSideAgentSessionListOpen, setIsSideAgentSessionListOpen] = useState(false);
  const [companionOpenComposerSelector, setCompanionOpenComposerSelector] = useState<{ scope: 'chat' | 'project'; type: 'mode' | 'auth' | 'provider' | 'model' | 'thinking' } | null>(null);
  const [companionDrafts, setCompanionDrafts] = useState<Record<string, string>>({});
  const [companionDropPreviewSide, setCompanionDropPreviewSide] = useState<CompanionSide | null>(null);
  const [isDraggingCompanion, setIsDraggingCompanion] = useState(false);
  const openTranscriptSenderProfile = useCallback((
    conversation: Conversation,
    message: Message,
    anchorRect: DOMRect,
  ) => {
    const participant = transcriptHumanParticipant(conversation, message);
    if (!participant || participant.role === 'self') return;
    setSenderProfileTarget({ participant, anchorRect });
  }, []);
  const openActiveTranscriptSenderProfile = useCallback((message: Message, anchorRect: DOMRect) => {
    openTranscriptSenderProfile(activeConv, message, anchorRect);
  }, [activeConv, openTranscriptSenderProfile]);
  const messageTranscriptContact = useCallback(async (contact: Contact) => {
    if (!onMessageContact) return;
    setSenderProfileTarget(null);
    await onMessageContact(contact);
  }, [onMessageContact]);

  useEffect(() => {
    setSenderProfileTarget(null);
  }, [activeConv.id]);
  const [isCompanionFolded, setIsCompanionFolded] = useState(false);
  const [splitLeftFraction, setSplitLeftFraction] = useState(0.5);
  const [pinnedMessageIdsByConversationId, setPinnedMessageIdsByConversationId] = useState<Record<string, string | null>>({});
  const [optimisticCloudPinBySessionId, setOptimisticCloudPinBySessionId] = useState<Record<string, CloudSessionPin>>({});
  const [pinDialog, setPinDialog] = useState<{ mode: 'pin' | 'unpin'; message: Message } | null>(null);
  const [pinForEveryone, setPinForEveryone] = useState(false);
  const [mainTranscriptNavigationRequest, setMainTranscriptNavigationRequest] = useState<TranscriptNavigationRequest | null>(null);
  const [companionTranscriptNavigationRequest, setCompanionTranscriptNavigationRequest] = useState<TranscriptNavigationRequest | null>(null);
  const transcriptNavigationNonceRef = useRef(0);
  const handleMainTranscriptNavigationHandled = useCallback((handled: TranscriptNavigationRequest) => {
    setMainTranscriptNavigationRequest((current) => (
      current && sameTranscriptNavigationRequest(current, handled) ? null : current
    ));
  }, []);
  const handleCompanionTranscriptNavigationHandled = useCallback((handled: TranscriptNavigationRequest) => {
    setCompanionTranscriptNavigationRequest((current) => (
      current && sameTranscriptNavigationRequest(current, handled) ? null : current
    ));
  }, []);
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  const companionTranscriptScrollRef = useRef<HTMLDivElement | null>(null);
  const companionAttachmentInputRef = useRef<HTMLInputElement | null>(null);
  const [companionDestination, setCompanionDestination] = useState<ChatDestination>('messages');
  const [companionActiveArtifactId, setCompanionActiveArtifactId] = useState<string | null>(null);
  const [companionActiveSourcePreview, setCompanionActiveSourcePreview] = useState<EditFilePreview | null>(null);
  const mainDestination: ChatDestination = isDetailPanelCollapsed
    ? 'messages'
    : detailDestinationFromTab(activeDetailTab);
  const companionActiveDetailTab: ChatDetailDestination = companionDestination === 'messages'
    ? 'info'
    : companionDestination;
  const selectMainDestination = useCallback((destination: ChatDestination) => {
    onClearSourcePreview?.();
    if (destination === 'messages') {
      setIsDetailPanelCollapsed(true);
      return;
    }
    setActiveDetailTab(destination);
    setIsDetailPanelCollapsed(false);
  }, [onClearSourcePreview, setActiveDetailTab, setIsDetailPanelCollapsed]);
  const prefersReducedMotion = useReducedMotion();
  const activeSessionId = (activeConv.canonicalSessionId || activeConv.id).trim();
  const activeCanonicalHistorySessionId = canonicalHistorySessionIdForConversation(activeConv);
  const activeLocalAgentConfigTargetSessionId = localAgentComposerConfigTargetSessionId(activeConv);
  const activeConversationIsGroupSession = isGroupSessionId(activeSessionId);
  const activeConversationIsGroupFork = isGroupForkSession(activeConv);
  const activeConversationUsesCloudPins = Boolean(
    activeSessionId
      && onUpdateCloudSessionPin
      && (
        activeConv.collaborationSources.some((sourceId) => isCloudCollaborationHostId(sourceId))
        || isCloudCollaborationHostId(activeConv.collaborationTarget?.hostId)
        || isCloudCollaborationHostId(activeConv.identity?.sourceHostId)
        || isCloudCollaborationConversationId(activeConv.id)
        || activeConversationIsGroupSession
      ),
  );
  useEffect(() => {
    if (!activeConversationUsesCloudPins || !activeSessionId || cloudSessionPin?.sessionId !== activeSessionId) return;
    setOptimisticCloudPinBySessionId((current) => {
      if (!current[activeSessionId]) return current;
      const next = { ...current };
      delete next[activeSessionId];
      return next;
    });
  }, [
    activeConversationUsesCloudPins,
    activeSessionId,
    cloudSessionPin?.effectiveMessageId,
    cloudSessionPin?.privateMessageId,
    cloudSessionPin?.sessionId,
    cloudSessionPin?.sharedMessageId,
    cloudSessionPin?.updatedAt,
  ]);
  const activeCloudSessionPin = activeConversationUsesCloudPins
    ? optimisticCloudPinBySessionId[activeSessionId] ?? cloudSessionPin ?? null
    : null;
  // Forking is hidden for group chats and historical group-derived forks because
  // the resulting private continuation/visibility semantics are confusing in a
  // shared chat. Local drafts and legacy ephemeral collaboration transports remain excluded
  // because they have no persistent backing to read from.
  const activeConversationIsForkable = Boolean(
    onForkChatMessage
      && activeConv.id
      && activeConv.id !== LOCAL_DRAFT_CHAT_CONVERSATION_ID
      && !activeConv.id.startsWith('bridge:')
      && !activeConversationIsGroupSession
      && !activeConversationIsGroupFork,
  );
  const handleForkMessage = activeConversationIsForkable && onForkChatMessage
    ? (entryId: string) => {
        void onForkChatMessage(activeConv.id, entryId);
      }
    : undefined;
  const companionCandidates = useMemo(
    () => chatCompanionCandidates(activeConv, chatConversations),
    [activeConv, chatConversations],
  );
  const suggestedCompanionConversation = useMemo(
    () => pairedCompanionConversation(activeConv, companionCandidates) ?? companionCandidates[0] ?? null,
    [activeConv, companionCandidates],
  );
  const selectedCompanionConversation = companionCandidates.find((conversation) => conversation.id === selectedCompanionConversationId) ?? null;
  const suggestedSideAgentConversation = selectedCompanionConversation ?? suggestedCompanionConversation;
  const companionConversation = chatSideAgentConversationForOpenRequest(openSideAgentConversationId, companionCandidates);
  const openCompanionTranscriptSenderProfile = useCallback((message: Message, anchorRect: DOMRect) => {
    if (!companionConversation) return;
    openTranscriptSenderProfile(companionConversation, message, anchorRect);
  }, [companionConversation, openTranscriptSenderProfile]);
  const companionCanonicalHistorySessionId = companionConversation
    ? canonicalHistorySessionIdForConversation(companionConversation)
    : null;
  const showCompanionPane = Boolean(companionConversation && !isCompanionFolded);
  const companionDraftText = companionConversation ? companionDrafts[companionConversation.id] ?? '' : '';
  const activePaneKind = conversationPaneKind(activeConv);
  const canOpenSideAgentPanel = Boolean(suggestedSideAgentConversation || (activePaneKind === 'agent' && onCreateAgentSession));
  const companionPaneKind = companionConversation ? conversationPaneKind(companionConversation) : null;
  const companionSide = chatCompanionSideForPaneKinds(activePaneKind, humanPaneSide);
  const companionConversationUsesCollaborationTransport = companionConversation?.collaborationSources.some((source) => source.trim().toLowerCase() !== 'local') ?? false;
  const companionConversationIsCollaborationAgent = Boolean(companionPaneKind === 'agent' && companionConversationUsesCollaborationTransport);
  const companionShowsLocalAgentControls = companionPaneKind === 'agent' && !companionConversationIsCollaborationAgent;
  const companionLocalAgentConfigTargetSessionId = companionConversation
    ? localAgentComposerConfigTargetSessionId(companionConversation)
    : null;
  const companionComposerRuntime = useCompanionComposerRuntime({
    enabled: companionShowsLocalAgentControls,
    isNativeShell,
    sessionId: companionLocalAgentConfigTargetSessionId,
    fallbackMode: composerSelection.mode,
    modelOptions: chatModelOptions ?? [],
    authOptions: composerAuthOptions,
  });
  useLayoutEffect(() => {
    setIsDetailPanelCollapsed(true);
  }, [activeConv.id, setIsDetailPanelCollapsed]);
  useEffect(() => {
    if (!isDetailPanelCollapsed && activeDetailTab === 'context') {
      setActiveDetailTab('info');
    }
  }, [activeDetailTab, isDetailPanelCollapsed, setActiveDetailTab]);
  useLayoutEffect(() => {
    setCompanionDestination('messages');
    setCompanionActiveArtifactId(null);
    setCompanionActiveSourcePreview(null);
  }, [companionConversation?.id]);
  const companionComposerSelection = companionComposerRuntime.selection;
  const companionComposerConfigTarget = companionComposerRuntime.configTarget;
  const toggleCompanionComposerSelector = (scope: 'chat' | 'project', type: 'mode' | 'auth' | 'provider' | 'model' | 'thinking') => {
    setCompanionOpenComposerSelector((current) => (current?.scope === scope && current.type === type ? null : { scope, type }));
  };
  const companionSuppressAgentReplyAttribution = companionConversation
    ? shouldSuppressAgentReplyAttribution(companionConversation)
    : false;
  const rawCompanionTranscriptLiveTurn = companionConversation?.previewLiveTurn ?? undefined;
  const companionTranscriptLiveTurn = rawCompanionTranscriptLiveTurn && companionConversation && rawCompanionTranscriptLiveTurn.sessionId === companionConversation.id
    ? rawCompanionTranscriptLiveTurn
    : undefined;
  const companionLiveTurnSender = companionConversation ? localOwnedAgentSenderLabel(companionConversation) : 'Kordi';
  const companionRuntimeContextStatus = companionConversation?.contextWindowStatus ?? null;
  const companionRuntimeCacheText = companionConversation?.cacheMonitorText ?? null;
  const companionCollaborationModelHost = useMemo(() => {
    if (!companionConversationIsCollaborationAgent) return null;
    const companionHostId = companionConversation?.collaborationTarget?.hostId?.trim() || null;
    if (companionHostId && activeCollaborationModelHost?.id === companionHostId) return activeCollaborationModelHost;
    if (!companionHostId && activeCollaborationModelHost) return activeCollaborationModelHost;
    return activeCollaborationModelHost;
  }, [activeCollaborationModelHost, companionConversation?.collaborationTarget?.hostId, companionConversationIsCollaborationAgent]);
  const companionCollaborationRoutingAgents = useMemo(
    () => localOwnedCollaborationAgentsForModelRouting(companionCollaborationModelHost ? [companionCollaborationModelHost] : [], desktopChatState),
    [companionCollaborationModelHost, desktopChatState],
  );
  const selectedCompanionCollaborationRoutingAgentBase = companionCollaborationRoutingAgents.find((agent) => agent.id === selectedCompanionCollaborationAgentId)
    ?? companionCollaborationRoutingAgents.find((agent) => agent.isActive)
    ?? companionCollaborationRoutingAgents.find((agent) => agent.isDefault)
    ?? companionCollaborationRoutingAgents[0]
    ?? null;
  const selectedCompanionCollaborationRoutingKey = selectedCompanionCollaborationRoutingAgentBase && companionConversation
    ? isCloudCollaborationHostId(selectedCompanionCollaborationRoutingAgentBase.hostId)
      ? `${selectedCompanionCollaborationRoutingAgentBase.hostId}:${companionConversation.canonicalSessionId ?? companionConversation.id}:${selectedCompanionCollaborationRoutingAgentBase.id}`
      : `${selectedCompanionCollaborationRoutingAgentBase.hostId}:${selectedCompanionCollaborationRoutingAgentBase.id}`
    : null;
  const selectedCompanionCollaborationRoutingAgent = selectedCompanionCollaborationRoutingAgentBase
    ? {
      ...selectedCompanionCollaborationRoutingAgentBase,
      ...(selectedCompanionCollaborationRoutingKey ? optimisticCollaborationAgentRouting[selectedCompanionCollaborationRoutingKey] : null),
    }
    : null;
  const companionCollaborationRoutingSelection = routingSelectionForCollaborationAgent(selectedCompanionCollaborationRoutingAgent);
  const companionCollaborationRoutingControlVisibility = collaborationChatRoutingControlVisibility(companionCollaborationRoutingAgents.length);
  const companionCollaborationAgentSelectorOpen = companionOpenComposerSelector?.scope === 'chat' && companionOpenComposerSelector.type === 'mode';
  const companionCollaborationRoutingTargetSessionId = companionConversation?.canonicalSessionId ?? companionConversation?.id ?? null;

  useEffect(() => {
    setOpenSideAgentConversationId(null);
    setSideAgentReferenceContext(null);
    setIsSideAgentActionsOpen(false);
    setIsSideAgentSessionListOpen(false);
    setIsCompanionFolded(false);
  }, [activeConv.id]);

  useEffect(() => {
    if (!showCompanionPane) {
      setIsSideAgentActionsOpen(false);
      setIsSideAgentSessionListOpen(false);
    }
  }, [showCompanionPane]);

  useEffect(() => {
    if (!selectedCompanionConversationId) return;
    if (!companionCandidates.some((conversation) => conversation.id === selectedCompanionConversationId)) {
      setSelectedCompanionConversationId(null);
    }
  }, [companionCandidates, selectedCompanionConversationId]);

  useEffect(() => {
    if (!openSideAgentConversationId) return;
    if (!companionCandidates.some((conversation) => conversation.id === openSideAgentConversationId)) {
      setOpenSideAgentConversationId(null);
      setSideAgentReferenceContext(null);
      setIsCompanionFolded(false);
    }
  }, [companionCandidates, openSideAgentConversationId]);

  // If the active session is itself a fork, show a backlink at the top
  // of the transcript so the user can navigate to the source session.
  const activeForkSourceSessionId = activeConversationIsGroupFork ? null : activeConv.forkedFromSessionId?.trim() || null;
  const activeForkSourceMessageIds = useMemo(
    () => activeConversationIsGroupFork ? new Set<string>() : forkSourceMessageIds(activeConv),
    [activeConv.forkedFromMessageId, activeConv.metadata, activeConversationIsGroupFork],
  );
  const activeForkSourceTitle = useMemo(() => {
    if (!activeForkSourceSessionId) return null;
    const summary = desktopChatState?.sessions.find((session) => session.id === activeForkSourceSessionId);
    return summary?.title || 'previous session';
  }, [activeForkSourceSessionId, desktopChatState?.sessions]);

  // Build a per-message lookup of forks anchored at each entry id of
  // the active session, so the transcript can render a "N forks" chip
  // and a popover listing them next to the message they branched from.
  const messageForksByEntryId = useMemo(() => {
    if (activeConversationIsGroupSession) return new Map<string, Array<{ sessionId: string; title: string; updatedAtLabel?: string }>>();
    const summaries = (desktopChatState?.sessions ?? []).filter((summary) => !isGroupForkSession(summary));
    const lineage = buildForkLineage(
      summaries.map((summary) => ({
        id: summary.id,
        forkedFromSessionId: summary.forkedFromSessionId ?? null,
        forkedFromMessageId: summary.forkedFromMessageId ?? null,
      })),
    );
    const forksAtMessage = lineage.forksByParentMessageIdBySession.get(activeConv.id);
    if (!forksAtMessage) return new Map<string, Array<{ sessionId: string; title: string; updatedAtLabel?: string }>>();
    const summaryById = new Map(summaries.map((summary) => [summary.id, summary]));
    const result = new Map<string, Array<{ sessionId: string; title: string; updatedAtLabel?: string }>>();
    for (const [messageId, forks] of forksAtMessage) {
      const entries = forks
        .map((fork) => summaryById.get(fork.id))
        .filter((summary): summary is NonNullable<typeof summary> => Boolean(summary))
        .map((summary) => ({
          sessionId: summary.id,
          title: summary.title || 'Untitled fork',
          updatedAtLabel: summary.updatedAtLabel,
        }));
      if (entries.length > 0) result.set(messageId, entries);
    }
    return result;
  }, [activeConv.id, activeConversationIsGroupSession, desktopChatState?.sessions]);
  const collaborationRoutingAgents = useMemo(
    () => localOwnedCollaborationAgentsForModelRouting(activeCollaborationModelHost ? [activeCollaborationModelHost] : [], desktopChatState),
    [activeCollaborationModelHost, desktopChatState],
  );
  const selectedCollaborationRoutingAgentBase = collaborationRoutingAgents.find((agent) => agent.id === selectedCollaborationAgentId)
    ?? collaborationRoutingAgents.find((agent) => agent.isActive)
    ?? collaborationRoutingAgents.find((agent) => agent.isDefault)
    ?? collaborationRoutingAgents[0]
    ?? null;
  const selectedCollaborationRoutingKey = selectedCollaborationRoutingAgentBase
    ? isCloudCollaborationHostId(selectedCollaborationRoutingAgentBase.hostId)
      ? `${selectedCollaborationRoutingAgentBase.hostId}:${activeConv.canonicalSessionId ?? activeConv.id}:${selectedCollaborationRoutingAgentBase.id}`
      : `${selectedCollaborationRoutingAgentBase.hostId}:${selectedCollaborationRoutingAgentBase.id}`
    : null;
  const selectedCollaborationRoutingAgent = selectedCollaborationRoutingAgentBase
    ? {
      ...selectedCollaborationRoutingAgentBase,
      ...(selectedCollaborationRoutingKey ? optimisticCollaborationAgentRouting[selectedCollaborationRoutingKey] : null),
    }
    : null;
  const collaborationRoutingSelection = routingSelectionForCollaborationAgent(selectedCollaborationRoutingAgent);
  const collaborationRoutingControlVisibility = collaborationChatRoutingControlVisibility(collaborationRoutingAgents.length);
  const collaborationAgentSelectorOpen = openComposerSelector?.scope === 'chat' && openComposerSelector.type === 'mode';
  const transcriptMessages = collapseAdjacentSessionConfigNotices(
    suppressLiveTurnEchoMessages(activeConv.messages, activeTranscriptLiveTurn),
  );
  const inferLatestHumanReplyTarget = shouldInferLatestHumanReplyTarget(activeConv);
  const suppressAgentReplyAttribution = shouldSuppressAgentReplyAttribution(activeConv);
  const attributedTranscriptMessages = transcriptMessages;
  const pinnedMessageId = activeConversationUsesCloudPins
    ? activeCloudSessionPin?.effectiveMessageId ?? null
    : pinnedMessageIdsByConversationId[activeConv.id] ?? null;
  const pinnedMessage = useMemo(() => {
    if (!pinnedMessageId) return null;
    return attributedTranscriptMessages.find((message) => (
      activeConversationUsesCloudPins
        ? pinnedMessageCandidateIds(message, activeConv.id).includes(pinnedMessageId)
        : chatMessageActionId(message) === pinnedMessageId
    )) ?? null;
  }, [activeConv.id, activeConversationUsesCloudPins, attributedTranscriptMessages, pinnedMessageId]);
  useEffect(() => {
    if (!pinnedMessageId || pinnedMessage || activeConversationUsesCloudPins) return;
    setPinnedMessageIdsByConversationId((current) => ({ ...current, [activeConv.id]: null }));
  }, [activeConv.id, activeConversationUsesCloudPins, pinnedMessage, pinnedMessageId]);
  const requestPinMessage = useCallback((message: Message) => {
    setPinForEveryone(false);
    setPinDialog({ mode: 'pin', message });
  }, []);
  const requestUnpinMessage = useCallback((message: Message) => {
    setPinDialog({ mode: 'unpin', message });
  }, []);
  const handleNavigateToTranscriptMessage = useCallback((messageId: string, sourceMessage?: MessageSourceReference) => {
    const targetMessageId = sourceMessage
      ? resolveTranscriptMessageIdForSource(sourceMessage, attributedTranscriptMessages)
      : messageId;
    const resolvedMessageId = targetMessageId || messageId;
    transcriptNavigationNonceRef.current += 1;
    setMainTranscriptNavigationRequest({ id: resolvedMessageId, nonce: transcriptNavigationNonceRef.current, sessionKey: activeConv.id });
  }, [activeConv.id, attributedTranscriptMessages]);
  const handleOpenPinnedMessage = useCallback(() => {
    if (!pinnedMessageId) return;
    handleNavigateToTranscriptMessage(pinnedMessage ? chatMessageActionId(pinnedMessage) : pinnedMessageId);
  }, [handleNavigateToTranscriptMessage, pinnedMessage, pinnedMessageId]);
  const handleConfirmPinDialog = useCallback(() => {
    if (!pinDialog) return;
    const messageId = activeConversationUsesCloudPins
      ? stableCloudPinMessageId(pinDialog.message, activeConv.id)
      : chatMessageActionId(pinDialog.message);
    const messageCandidateIds = pinnedMessageCandidateIds(pinDialog.message, activeConv.id);
    setPinDialog(null);
    if (!messageId) return;

    if (activeConversationUsesCloudPins && onUpdateCloudSessionPin && activeSessionId) {
      const sharedPinnedMessageId = activeCloudSessionPin?.sharedMessageId?.trim() ?? '';
      const scope = pinDialog.mode === 'pin'
        ? (pinForEveryone ? 'shared' : 'private')
        : sharedPinnedMessageId && messageCandidateIds.includes(sharedPinnedMessageId) ? 'shared' : 'private';
      const nextMessageId = pinDialog.mode === 'pin' ? messageId : null;
      const now = new Date().toISOString();
      const base: CloudSessionPin = activeCloudSessionPin ?? {
        sessionId: activeSessionId,
        sharedMessageId: null,
        privateMessageId: null,
        effectiveMessageId: null,
        updatedAt: null,
      };
      const optimistic: CloudSessionPin = scope === 'shared'
        ? { ...base, sharedMessageId: nextMessageId, effectiveMessageId: base.privateMessageId || nextMessageId, updatedAt: now }
        : { ...base, privateMessageId: nextMessageId, effectiveMessageId: nextMessageId || base.sharedMessageId, updatedAt: now };
      setOptimisticCloudPinBySessionId((current) => ({ ...current, [activeSessionId]: optimistic }));
      void onUpdateCloudSessionPin({ sessionId: activeSessionId, messageId: nextMessageId, scope })
        .then((pin) => {
          setOptimisticCloudPinBySessionId((current) => ({ ...current, [pin.sessionId]: pin }));
        })
        .catch(() => {
          setOptimisticCloudPinBySessionId((current) => {
            const next = { ...current };
            delete next[activeSessionId];
            return next;
          });
        });
      return;
    }

    setPinnedMessageIdsByConversationId((current) => ({
      ...current,
      [activeConv.id]: pinDialog.mode === 'pin' ? messageId : null,
    }));
  }, [activeCloudSessionPin, activeConv.id, activeConversationUsesCloudPins, activeSessionId, onUpdateCloudSessionPin, pinDialog, pinForEveryone]);
  // Index of the last message that came from the fork's snapshot
  // (everything inherited from the source up through the anchor). The
  // divider goes after this message so any continuation the user
  // sends in the fork shows up below it.
  const forkSnapshotBoundaryIndex = useMemo(() => {
    if (!activeForkSourceSessionId) return -1;
    return forkSnapshotBoundaryIndexForMessages(
      attributedTranscriptMessages,
      activeForkSourceMessageIds,
    );
  }, [activeForkSourceSessionId, activeForkSourceMessageIds, attributedTranscriptMessages]);
  const attributedActiveTranscriptLiveTurn = activeTranscriptLiveTurn;
  const shouldRenderLiveTurn = Boolean(attributedActiveTranscriptLiveTurn && !attributedActiveTranscriptLiveTurn.completed);
  const companionTranscriptMessages = useMemo(() => {
    if (!companionConversation) return [] as Message[];
    return collapseAdjacentSessionConfigNotices(
      suppressLiveTurnEchoMessages(companionConversation.messages, companionTranscriptLiveTurn),
    );
  }, [companionConversation, companionTranscriptLiveTurn]);
  const handleNavigateToCompanionTranscriptMessage = useCallback((messageId: string, sourceMessage?: MessageSourceReference) => {
    if (!companionConversation) return;
    const targetMessageId = sourceMessage
      ? resolveTranscriptMessageIdForSource(sourceMessage, companionTranscriptMessages)
      : messageId;
    const resolvedMessageId = targetMessageId || messageId;
    transcriptNavigationNonceRef.current += 1;
    setCompanionActiveSourcePreview(null);
    setCompanionDestination('messages');
    setCompanionTranscriptNavigationRequest({ id: resolvedMessageId, nonce: transcriptNavigationNonceRef.current, sessionKey: companionConversation.id });
  }, [companionConversation, companionTranscriptMessages]);
  const attributedCompanionTranscriptLiveTurn = companionTranscriptLiveTurn;
  const shouldRenderCompanionLiveTurn = Boolean(attributedCompanionTranscriptLiveTurn && !attributedCompanionTranscriptLiveTurn.completed);
  const companionLiveTurnIsRunning = Boolean(attributedCompanionTranscriptLiveTurn && !attributedCompanionTranscriptLiveTurn.completed);
  const updateCompanionDropPreview = (event: DragEvent<HTMLElement>) => {
    if (!companionConversation || isCompanionFolded) return null;
    const rect = event.currentTarget.getBoundingClientRect();
    const side = chatCompanionSideFromDropPosition(event.clientX, rect.left, rect.width);
    setCompanionDropPreviewSide(side);
    return side;
  };
  const handleCompanionDragStart = (event: DragEvent<HTMLElement>) => {
    if (!companionConversation) return;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(CHAT_COMPANION_DRAG_TYPE, companionConversation.id);
    setIsDraggingCompanion(true);
    setCompanionDropPreviewSide(companionSide);
  };
  const handleCompanionDragEnd = () => {
    setIsDraggingCompanion(false);
    setCompanionDropPreviewSide(null);
  };
  const handleCompanionDragOver = (event: DragEvent<HTMLElement>) => {
    if (!isDraggingCompanion) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    updateCompanionDropPreview(event);
  };
  const handleCompanionDrop = (event: DragEvent<HTMLElement>) => {
    if (!isDraggingCompanion) return;
    event.preventDefault();
    const side = updateCompanionDropPreview(event);
    if (side) setHumanPaneSide(humanSideForCompanionSide(activePaneKind, side));
    setIsDraggingCompanion(false);
    setCompanionDropPreviewSide(null);
  };
  const updateCompanionDraft = (conversationId: string, value: string, target?: HTMLTextAreaElement) => {
    setCompanionDrafts((current) => ({
      ...current,
      [conversationId]: value,
    }));
    setChatComposerTextForSession(conversationId, value);
    if (!target) return;
    target.style.height = '0px';
    target.style.height = `${Math.min(target.scrollHeight, 160)}px`;
  };
  const sendCompanionDraft = (conversation: Conversation) => {
    const draft = companionDrafts[conversation.id] ?? '';
    if (!draft.trim() && chatComposerAttachments.length === 0) return;
    const referenceContextMessage = sideAgentReferenceContext
      ? buildAskAgentSessionReferenceContextMessage(activeConv, sideAgentReferenceContext)
      : null;
    const contextMessages = referenceContextMessage ? [referenceContextMessage] : [];
    onSendChatMessage(draft, conversation.id, contextMessages);
    scheduleTranscriptScrollToBottom(companionTranscriptScrollRef);
    setCompanionDrafts((current) => {
      const next = { ...current };
      delete next[conversation.id];
      return next;
    });
  };
  const closeCompanionCollaborationRoutingSelector = (type: 'provider' | 'model' | 'thinking') => {
    if (companionOpenComposerSelector?.scope === 'chat' && companionOpenComposerSelector.type === type) {
      setCompanionOpenComposerSelector(null);
    }
  };
  const companionDefaultThinkingForCollaborationModel = (modelValue: string | null | undefined, currentThinking: string | null | undefined) => {
    const thinkingLevels = chatModelOptions?.find((option) => option.value === modelValue)?.thinkingLevels ?? [];
    return fallbackComposerThinkingValue(thinkingLevels, currentThinking ?? 'default');
  };
  const applyCollaborationAgentRoutingUpdate = ({
    agent,
    routingKey,
    patch,
    isBusy,
    setNotice,
    targetSessionId,
  }: {
    agent: LocalCollaborationAgentRoutingOption | null;
    routingKey: string | null;
    patch: DesktopCollaborationAgentRouting;
    isBusy: boolean;
    setNotice: Dispatch<SetStateAction<string | null>>;
    targetSessionId?: string | null;
  }) => {
    if (!agent || !routingKey) return;
    if (isBusy) {
      setNotice("Stop the running task before changing this session's model or thinking level.");
      return;
    }

    const { routing, defaultAuthChanged, fallbackAuthChanged } = resolveCollaborationAgentRoutingUpdate(agent, patch);
    const noticeText = collaborationAgentRoutingChangeNotice({
      agentLabel: agent.label,
      currentModel: agent.defaultModel,
      nextModel: patch.defaultModel,
      currentThinking: agent.thinking,
      nextThinking: patch.thinking,
      modelLabel: collaborationRouteDisplayName(
        routing.defaultModel,
        routing.defaultAuthProvider,
        routing.defaultAuthChoice,
        chatModelOptions,
        composerProviderOptions,
      ),
      thinkingLabel: collaborationThinkingDisplayName(routing.thinking),
    }) ?? ((defaultAuthChanged || fallbackAuthChanged)
      ? `${agent.label} model route changed to ${collaborationRouteDisplayName(
        routing.defaultModel,
        routing.defaultAuthProvider,
        routing.defaultAuthChoice,
        chatModelOptions,
        composerProviderOptions,
      )}. Only you can see this.`
      : null);
    if (!noticeText) return;

    setOptimisticCollaborationAgentRouting((current) => ({
      ...current,
      [routingKey]: routing,
    }));
    setNotice(noticeText);
    void onUpdateCollaborationAgentModelRouting(
      agent.hostId,
      agent.id,
      routing.defaultModel,
      routing.fallbackModel,
      routing.thinking,
      routing.defaultAuthProvider,
      routing.defaultAuthChoice,
      routing.fallbackAuthProvider,
      routing.fallbackAuthChoice,
      targetSessionId,
    ).catch((error) => {
      setNotice(error instanceof Error ? error.message : 'Unable to update collaboration agent model routing');
    });
  };
  const updateCompanionCollaborationAgentRouting = ({
    defaultModel,
    defaultAuthProvider,
    defaultAuthChoice,
    fallbackModel,
    fallbackAuthProvider,
    fallbackAuthChoice,
    thinking,
    selectorType,
  }: {
    defaultModel?: string | null;
    defaultAuthProvider?: string | null;
    defaultAuthChoice?: string | null;
    fallbackModel?: string | null;
    fallbackAuthProvider?: string | null;
    fallbackAuthChoice?: string | null;
    thinking?: string | null;
    selectorType?: 'provider' | 'model' | 'thinking';
  }) => {
    if (selectorType) closeCompanionCollaborationRoutingSelector(selectorType);
    applyCollaborationAgentRoutingUpdate({
      agent: selectedCompanionCollaborationRoutingAgent,
      routingKey: selectedCompanionCollaborationRoutingKey,
      patch: {
        defaultModel,
        defaultAuthProvider,
        defaultAuthChoice,
        fallbackModel,
        fallbackAuthProvider,
        fallbackAuthChoice,
        thinking,
      },
      isBusy: isDesktopChatSending || companionLiveTurnIsRunning,
      setNotice: setCompanionCollaborationRoutingNotice,
      targetSessionId: companionCollaborationRoutingTargetSessionId,
    });
  };
  const createSideAgentSession = async (initialPrompt = '') => {
    if (!onCreateAgentSession) return false;
    const createdConversationId = await onCreateAgentSession();
    if (!createdConversationId) return false;
    setHumanPaneSide(humanSideForCompanionSide(activePaneKind, 'right'));
    setOpenSideAgentConversationId(createdConversationId);
    setSelectedCompanionConversationId(createdConversationId);
    setSideAgentReferenceContext(buildAskAgentSessionReferenceContext(activeConv));
    setIsCompanionFolded(false);
    const trimmedPrompt = initialPrompt.trim();
    if (trimmedPrompt) {
      updateCompanionDraft(createdConversationId, trimmedPrompt);
    }
    return true;
  };
  const openSideAgentPanel = async (initialPrompt = '') => {
    if (activePaneKind === 'agent' && onCreateAgentSession) {
      return createSideAgentSession(initialPrompt);
    }
    const targetConversation = selectedCompanionConversation ?? suggestedSideAgentConversation;
    if (!targetConversation) return false;
    setHumanPaneSide(humanSideForCompanionSide(activePaneKind, 'right'));
    setOpenSideAgentConversationId(targetConversation.id);
    setSelectedCompanionConversationId(targetConversation.id);
    setSideAgentReferenceContext(buildAskAgentSessionReferenceContext(activeConv));
    setIsCompanionFolded(false);
    const trimmedPrompt = initialPrompt.trim();
    if (trimmedPrompt) {
      updateCompanionDraft(targetConversation.id, trimmedPrompt);
    }
    return true;
  };
  const handleSendChatMessage = (draftOverride?: string) => {
    const draft = draftOverride ?? chatComposerText;
    const trigger = parseAskAgentTriggerCommand(draft);
    if (trigger) {
      void openSideAgentPanel(trigger.prompt).then((opened) => {
        if (opened) setChatComposerText('');
      });
      return;
    }
    const shouldJumpToSentMessage = draft.trim().length > 0 || chatComposerAttachments.length > 0;
    onSendChatMessage(draftOverride);
    if (shouldJumpToSentMessage) {
      scheduleTranscriptScrollToBottom(chatTranscriptScrollRef);
    }
  };
  const updateSplitFromPointer = (clientX: number) => {
    const container = splitContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0) return;
    setSplitLeftFraction(clampChatSplitFraction((clientX - rect.left) / rect.width));
  };
  const handleSplitDividerPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    updateSplitFromPointer(event.clientX);
  };
  const handleSplitDividerPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    updateSplitFromPointer(event.clientX);
  };
  const handleSplitDividerPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const companionDestinationPage = companionConversation && companionDestination !== 'messages' ? (
    <CompanionDestinationPage
      conversation={companionConversation}
      destination={companionActiveDetailTab}
      isNativeShell={isNativeShell}
      liveTurn={attributedCompanionTranscriptLiveTurn}
      activeArtifactId={companionActiveArtifactId}
      activeSourcePreview={companionActiveSourcePreview}
      actions={{
        setDestination: setCompanionDestination,
        setActiveArtifactId: setCompanionActiveArtifactId,
        setActiveSourcePreview: setCompanionActiveSourcePreview,
        onNavigateToResponse: handleNavigateToCompanionTranscriptMessage,
        onOpenOutreachThread: onSelectSession,
      }}
    />
  ) : null;
  const companionPane = companionConversation ? (
    <CompanionPane
      conversation={companionConversation}
      side={companionSide}
      destination={companionDestination}
      header={(
        <CompanionHeader
          conversation={companionConversation}
          candidates={companionCandidates}
          side={companionSide}
          destination={companionDestination}
          menu={{
            actionsOpen: isSideAgentActionsOpen,
            sessionListOpen: isSideAgentSessionListOpen,
            canCreateSession: Boolean(onCreateAgentSession),
          }}
          actions={{
            onDragStart: handleCompanionDragStart,
            onDragEnd: handleCompanionDragEnd,
            onToggleActions: () => {
              setIsSideAgentActionsOpen((open) => !open);
              setIsSideAgentSessionListOpen(false);
            },
            onCloseSessionList: () => setIsSideAgentSessionListOpen(false),
            onOpenSessionList: () => setIsSideAgentSessionListOpen(true),
            onSwitchConversation: (conversationId) => {
              setSelectedCompanionConversationId(conversationId);
              setOpenSideAgentConversationId(conversationId);
              setIsSideAgentActionsOpen(false);
              setIsSideAgentSessionListOpen(false);
              setCompanionOpenComposerSelector(null);
            },
            onCreateSession: () => {
              setIsSideAgentActionsOpen(false);
              setIsSideAgentSessionListOpen(false);
              void createSideAgentSession();
            },
            onClose: () => {
              setOpenSideAgentConversationId(null);
              setSelectedCompanionConversationId(null);
              setSideAgentReferenceContext(null);
              setIsSideAgentActionsOpen(false);
              setIsSideAgentSessionListOpen(false);
              setCompanionOpenComposerSelector(null);
            },
            onSelectDestination: (destination) => {
              setCompanionActiveSourcePreview(null);
              setCompanionDestination(destination);
            },
          }}
        />
      )}
      detailPage={companionDestinationPage}
      sessionPane={{
        presentation: {
          liveTurn: attributedCompanionTranscriptLiveTurn,
          liveTurnSender: companionLiveTurnSender,
          shouldRenderLiveTurn: shouldRenderCompanionLiveTurn,
          densityMode: chatTranscriptDensityMode(companionConversation),
          inferLatestHumanReplyTarget: shouldInferLatestHumanReplyTarget(companionConversation),
          plainAgentResponse: companionSuppressAgentReplyAttribution,
        },
        actions: {
          onOpenSource: (file) => {
            setCompanionActiveSourcePreview(file);
            setCompanionDestination('artifacts');
          },
          onOpenArtifact: (artifactId) => {
            setCompanionActiveSourcePreview(null);
            setCompanionActiveArtifactId(artifactId);
            setCompanionDestination('artifacts');
          },
          onOpenAuthSettings: openAuthentication,
          onNavigateToMessage: handleNavigateToCompanionTranscriptMessage,
          onOpenMessageDetail: onSelectMessage,
          onStopCollaborationAgentRequest,
          onStopActiveTurn: onStopDesktopChatTurn,
          onRequestCollaborationContact,
          onOpenSenderProfile: openCompanionTranscriptSenderProfile,
          onForkMessage: onForkChatMessage
            ? (entryId) => void onForkChatMessage(companionConversation.id, entryId)
            : undefined,
          onOpenForkSession: onSelectSession,
          onForwardMessage,
          onSelectMessage,
        },
        selection: {},
        viewport: {
          sessionKey: companionConversation.id,
          messages: companionTranscriptMessages,
          scrollRef: companionTranscriptScrollRef,
          scrollClassName: 'min-h-0 flex-1 overflow-x-hidden overscroll-contain px-3 py-5',
          hasOlderMessages: Boolean(
            companionCanonicalHistorySessionId
              && canonicalHasOlderBySessionId[companionCanonicalHistorySessionId]
          ),
          onLoadOlderMessages: companionCanonicalHistorySessionId && onLoadOlderCanonicalSessionMessages
            ? () => onLoadOlderCanonicalSessionMessages(companionCanonicalHistorySessionId)
            : undefined,
          navigationRequest: companionTranscriptNavigationRequest,
          onNavigationHandled: handleCompanionTranscriptNavigationHandled,
          queuedMessages: queuedDesktopMessagesBySession[companionConversation.id] ?? [],
          onEditQueuedMessage,
          onCancelQueuedMessage,
          emptyState: (
            <div className="flex h-full min-h-[12rem] items-center justify-center px-4 text-center text-[12px] text-slate-500">
              No messages in this side chat yet.
            </div>
          ),
        },
      }}
      composerShell={{
        className: 'pt-3',
        chatComposerAttachments,
        saveDesktopAttachments,
        saveDesktopAttachmentPaths,
        removeChatComposerAttachment,
        activeChatQuote,
        onForwardMessage,
        rightDetailRail,
        setIsDetailPanelCollapsed,
      }}
      composer={(
        <CompanionComposer
          conversation={companionConversation}
          paneKind={companionPaneKind ?? 'agent'}
          draftText={companionDraftText}
          isNativeShell={isNativeShell}
          attachmentInputRef={companionAttachmentInputRef}
          composer={composer}
          runtime={runtime}
          localRouting={{
            enabled: companionShowsLocalAgentControls,
            selection: companionComposerSelection,
            configTarget: companionComposerConfigTarget,
            authLabel: companionComposerRuntime.authLabel,
            authOptions: companionComposerRuntime.authOptions,
            isLoading: companionComposerRuntime.isLoading,
            loadError: companionComposerRuntime.loadError,
            retry: companionComposerRuntime.retry,
            runtimeContextStatus: companionRuntimeContextStatus,
            runtimeCacheText: companionRuntimeCacheText,
          }}
          collaborationRouting={{
            enabled: companionConversationIsCollaborationAgent,
            notice: companionCollaborationRoutingNotice,
            agents: companionCollaborationRoutingAgents,
            selectedAgent: selectedCompanionCollaborationRoutingAgent,
            selection: companionCollaborationRoutingSelection,
            visibility: companionCollaborationRoutingControlVisibility,
            selectorOpen: companionCollaborationAgentSelectorOpen,
            setSelectedAgentId: setSelectedCompanionCollaborationAgentId,
            update: updateCompanionCollaborationAgentRouting,
            defaultThinkingForModel: companionDefaultThinkingForCollaborationModel,
          }}
          ui={{
            openSelector: companionOpenComposerSelector,
            setOpenSelector: setCompanionOpenComposerSelector,
            toggleSelector: toggleCompanionComposerSelector,
            prefersReducedMotion,
          }}
          onDraftChange={updateCompanionDraft}
          onSend={sendCompanionDraft}
        />
      )}
    />
  ) : null;
  const splitDivider = showCompanionPane && companionConversation ? (
    <div
      className="app-chat-split-divider group relative z-10 flex h-full w-2.5 cursor-col-resize touch-none items-center justify-center bg-transparent transition hover:bg-white/[0.035]"
      data-split-layout-divider="true"
      onPointerDown={handleSplitDividerPointerDown}
      onPointerMove={handleSplitDividerPointerMove}
      onPointerUp={handleSplitDividerPointerUp}
      onPointerCancel={handleSplitDividerPointerUp}
      title="Drag to resize chats"
      aria-label="Resize side-by-side chats"
      role="separator"
      aria-orientation="vertical"
    >
      <span
        className="pointer-events-none flex h-9 w-full items-center justify-center text-[color:var(--utility-muted-text)] opacity-45 transition group-hover:opacity-80"
        data-split-layout-grip="true"
        aria-hidden="true"
      >
        <GripVertical className="h-4 w-4" />
      </span>
    </div>
  ) : null;
  useEffect(() => {
    if (!collaborationRoutingNotice) return;
    const timeoutId = window.setTimeout(() => {
      setCollaborationRoutingNotice(null);
    }, COLLABORATION_ROUTING_NOTICE_AUTO_DISMISS_MS);
    return () => window.clearTimeout(timeoutId);
  }, [collaborationRoutingNotice]);

  const closeCollaborationRoutingSelector = (type: 'provider' | 'model' | 'thinking') => {
    if (openComposerSelector?.scope === 'chat' && openComposerSelector.type === type) {
      toggleComposerSelector('chat', type);
    }
  };

  const defaultThinkingForCollaborationModel = (modelValue: string | null | undefined, currentThinking: string | null | undefined) => {
    const thinkingLevels = chatModelOptions?.find((option) => option.value === modelValue)?.thinkingLevels ?? [];
    return fallbackComposerThinkingValue(thinkingLevels, currentThinking ?? 'default');
  };

  const updateCollaborationAgentRouting = ({
    defaultModel,
    defaultAuthProvider,
    defaultAuthChoice,
    fallbackModel,
    fallbackAuthProvider,
    fallbackAuthChoice,
    thinking,
    selectorType,
  }: {
    defaultModel?: string | null;
    defaultAuthProvider?: string | null;
    defaultAuthChoice?: string | null;
    fallbackModel?: string | null;
    fallbackAuthProvider?: string | null;
    fallbackAuthChoice?: string | null;
    thinking?: string | null;
    selectorType?: 'provider' | 'model' | 'thinking';
  }) => {
    if (selectorType) closeCollaborationRoutingSelector(selectorType);
    focusComposerTextarea(CHAT_COMPOSER_TEXTAREA_SELECTOR);
    applyCollaborationAgentRoutingUpdate({
      agent: selectedCollaborationRoutingAgent,
      routingKey: selectedCollaborationRoutingKey,
      patch: {
        defaultModel,
        defaultAuthProvider,
        defaultAuthChoice,
        fallbackModel,
        fallbackAuthProvider,
        fallbackAuthChoice,
        thinking,
      },
      isBusy: isDesktopChatSending || activeLiveTurnIsRunning,
      setNotice: setCollaborationRoutingNotice,
    });
  };

  const saveCompactModelRoute = (input: CompactComposerModelMenuSaveInput) => {
    if (activeConversationUsesCollaboration && selectedCollaborationRoutingAgent) {
      updateCollaborationAgentRouting({
        defaultModel: input.model,
        defaultAuthProvider: input.providerOption?.providerId ?? selectedCollaborationRoutingAgent.defaultAuthProvider ?? null,
        defaultAuthChoice: input.providerOption ? authChoiceFromProviderOption(input.providerOption) : selectedCollaborationRoutingAgent.defaultAuthChoice ?? null,
        fallbackModel: selectedCollaborationRoutingAgent.fallbackModel ?? null,
        fallbackAuthProvider: selectedCollaborationRoutingAgent.fallbackAuthProvider ?? null,
        fallbackAuthChoice: selectedCollaborationRoutingAgent.fallbackAuthChoice ?? null,
        thinking: input.thinking,
      });
      return;
    }

    void (async () => {
      if (input.providerOption) {
        await selectComposerProviderChoice('chat', input.providerOption);
      }
      if (input.model !== composerSelection.model) {
        await selectComposerValue('chat', 'model', input.model);
      }
      if (input.thinking !== composerSelection.thinking) {
        await selectComposerValue('chat', 'thinking', input.thinking);
      }
    })();
  };

  const chatSplitGridColumns = (() => {
    if (!showCompanionPane) return undefined;
    if (companionSide === 'left') {
      return `minmax(280px, ${splitLeftFraction}fr) 10px minmax(280px, ${1 - splitLeftFraction}fr)`;
    }
    return `minmax(280px, ${splitLeftFraction}fr) 10px minmax(280px, ${1 - splitLeftFraction}fr)`;
  })();

  const commitActiveSelfAgentSessionTitle = async () => {
    const baselineName = activeConv.name;
    const nextTitle = desktopSessionRenameDraft.trim();
    if (!canRenameActiveSelfAgentSession || !nextTitle) {
      setDesktopSessionRenameDraft(baselineName);
      setIsEditingDesktopSessionTitle(false);
      return;
    }
    if (nextTitle === baselineName.trim()) {
      setIsEditingDesktopSessionTitle(false);
      return;
    }
    if (activeSelfAgentSessionId) {
      await onRenameChatSession(activeSelfAgentSessionId, nextTitle);
      setDesktopSessionRenameDraft(nextTitle);
      setIsEditingDesktopSessionTitle(false);
      return;
    }
    await onRenameDesktopSession(baselineName);
  };

  const beginActiveSelfAgentSessionTitleRename = () => {
    if (!canRenameActiveSelfAgentSession) return;
    setDesktopSessionRenameDraft(activeConv.name);
    setIsEditingDesktopSessionTitle(true);
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <div
        ref={splitContainerRef}
        className={cn(
          'relative min-h-0 flex-1 overflow-hidden',
          chatSplitGridColumns && 'grid',
          isDraggingCompanion && 'ring-1 ring-sky-300/25',
          companionDropPreviewSide === 'left' && 'bg-gradient-to-r from-sky-400/10 via-transparent to-transparent',
          companionDropPreviewSide === 'right' && 'bg-gradient-to-l from-sky-400/10 via-transparent to-transparent',
        )}
        style={chatSplitGridColumns ? { gridTemplateColumns: chatSplitGridColumns } : undefined}
        data-chat-companion-side={showCompanionPane ? companionSide : 'folded'}
        data-chat-companion-drop-preview={companionDropPreviewSide ?? undefined}
        onDragOver={handleCompanionDragOver}
        onDrop={handleCompanionDrop}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setCompanionDropPreviewSide(null);
          }
        }}
      >
        {showCompanionPane && companionSide === 'left' ? companionPane : null}
        {showCompanionPane && companionSide === 'left' ? splitDivider : null}
        <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-white/[0.025]" data-active-side={companionSide === 'left' ? 'right' : 'left'}>
          <MainChatHeader
            conversation={activeConv}
            layout={{
              showSessionToggle: showChatDetailRail,
              sessionsCollapsed: collapseChatSessions,
              onToggleSessions: () => {
                setIsSessionPanelCollapsed((collapsed) => !collapsed);
              },
              showDestinations: showRightDetailRail,
              destination: mainDestination,
              onSelectDestination: selectMainDestination,
            }}
            metadata={{
              subtitle: activeSessionSubtitle,
              cloudSyncLabel: activeCloudSelfAgentSyncLabel,
              cloudSyncStatus: cloudSelfAgentSyncStatus,
              forkSourceSessionId: activeForkSourceSessionId,
              forkSourceTitle: activeForkSourceTitle ?? 'source session',
              onOpenForkSource: onSelectSession,
            }}
            rename={{
              enabled: canRenameActiveSelfAgentSession,
              editing: isEditingDesktopSessionTitle,
              draft: desktopSessionRenameDraft,
              sessionId: activeSelfAgentSessionId ?? activeConv.id,
              setDraft: setDesktopSessionRenameDraft,
              begin: beginActiveSelfAgentSessionTitleRename,
              cancel: () => {
                setDesktopSessionRenameDraft(activeConv.name);
                setIsEditingDesktopSessionTitle(false);
              },
              commit: () => {
                void commitActiveSelfAgentSessionTitle();
              },
            }}
            companion={{
              canOpen: canOpenSideAgentPanel,
              isOpen: showCompanionPane,
              suggestedName: suggestedSideAgentConversation?.name,
              onOpen: () => {
                void openSideAgentPanel();
              },
            }}
          />

      {mainDestination === 'messages' ? (
      <div
        id="chat-main-messages-panel"
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
        role="tabpanel"
        aria-labelledby="chat-main-messages-tab"
        data-chat-destination-page="messages"
        data-chat-destination-scope="main"
      >
      {!hasAnyAuth && !activeConversationUsesCollaboration ? (
        <AuthNoticeBanner
          title="No provider connected yet"
          description={authNoticeDescription}
          actionLabel={authNoticeActionLabel}
          onAction={onOpenAccountAuthentication ?? onOpenAuthSettings}
        />
      ) : null}

      {pinnedMessage ? (
        <PinnedMessageBar
          message={pinnedMessage}
          onOpenMessage={handleOpenPinnedMessage}
          onRequestUnpin={() => requestUnpinMessage(pinnedMessage)}
        />
      ) : null}

      <ChatSessionPane
        presentation={{
          liveTurn: attributedActiveTranscriptLiveTurn,
          liveTurnSender,
          shouldRenderLiveTurn,
          densityMode: chatTranscriptDensityMode(activeConv),
          isCompressionActive,
          plainAgentResponse: suppressAgentReplyAttribution,
          inferLatestHumanReplyTarget,
          forkSnapshotBoundaryIndex,
          activeForkSourceSessionId,
          activeForkSourceTitle,
          messageForksByEntryId,
          pinnedMessageId,
        }}
        actions={{
          onSelectSession,
          onOpenSource,
          onOpenArtifact,
          onOpenAuthSettings: openAuthentication,
          onNavigateToMessage: handleNavigateToTranscriptMessage,
          onOpenMessageDetail: onSelectMessage,
          onStopCollaborationAgentRequest,
          onStopActiveTurn: onStopDesktopChatTurn,
          onRequestCollaborationContact,
          onOpenSenderProfile: openActiveTranscriptSenderProfile,
          onForkMessage: handleForkMessage,
          onOpenForkSession: onSelectSession,
          onReplyMessage,
          onForwardMessage,
          onRetryMessage: onRetryChatMessage,
          onSelectMessage,
          onRequestPinMessage: requestPinMessage,
          onRequestUnpinMessage: requestUnpinMessage,
        }}
        selection={{
          selectionMode: messageSelectionMode,
          selectedMessageIds,
          isMessageSelectable,
          onToggleSelectedMessage,
          onSelectionDragStart,
          onSelectionDragEnter,
          onSelectionDragEnd,
        }}
        viewport={{
          sessionKey: activeConv.id,
          messages: attributedTranscriptMessages,
          scrollRef: chatTranscriptScrollRef,
          scrollClassName: 'min-h-0 flex-1 overflow-x-hidden overscroll-contain px-3.5 py-5 sm:px-4',
          hasOlderMessages: Boolean(
            activeCanonicalHistorySessionId
              && canonicalHasOlderBySessionId[activeCanonicalHistorySessionId]
          ),
          onLoadOlderMessages: activeCanonicalHistorySessionId && onLoadOlderCanonicalSessionMessages
            ? () => onLoadOlderCanonicalSessionMessages(activeCanonicalHistorySessionId)
            : undefined,
          emptyState: activeSelfAgentSessionIsStarting ? <SessionStartingState /> : null,
          navigationRequest: mainTranscriptNavigationRequest,
          onNavigationHandled: handleMainTranscriptNavigationHandled,
          onTranscriptScroll,
          queuedMessages: queuedDesktopMessages,
          onEditQueuedMessage,
          onCancelQueuedMessage,
          composer: (
          <ChatComposerShell
            chatComposerAttachments={chatComposerAttachments}
            saveDesktopAttachments={saveDesktopAttachments}
            saveDesktopAttachmentPaths={saveDesktopAttachmentPaths}
            removeChatComposerAttachment={removeChatComposerAttachment}
            activeChatQuote={activeChatQuote}
            onForwardMessage={onForwardMessage}
            onOpenMessageDetail={onSelectMessage}
            rightDetailRail={rightDetailRail}
            setIsDetailPanelCollapsed={setIsDetailPanelCollapsed}
          >
            <MainComposer
              conversation={activeConv}
              composer={composer}
              runtime={runtime}
              localRouting={{
                paneKind: activePaneKind,
                configTarget: activeLocalAgentConfigTargetSessionId,
                contextStatus: activeRuntimeContextStatus,
                cacheText: activeRuntimeCacheText,
              }}
              collaborationRouting={{
                enabled: activeConversationUsesCollaboration,
                notice: collaborationRoutingNotice,
                model: selectedCollaborationRoutingAgent ? {
                  agents: collaborationRoutingAgents,
                  selectedAgent: selectedCollaborationRoutingAgent,
                  selection: collaborationRoutingSelection,
                  visibility: collaborationRoutingControlVisibility,
                } : null,
                agentSelectorOpen: collaborationAgentSelectorOpen,
                onSelectAgent: (agentId) => {
                  setSelectedCollaborationAgentId(agentId);
                  toggleComposerSelector('chat', 'mode');
                },
                onUpdate: updateCollaborationAgentRouting,
                onSaveCompact: saveCompactModelRoute,
                defaultThinkingForModel: defaultThinkingForCollaborationModel,
              }}
              display={{
                isNativeShell,
                showCompanionPane,
                activeLiveTurnIsRunning,
                prefersReducedMotion,
                placeholder: chatComposerPlaceholderText,
              }}
              onSend={handleSendChatMessage}
            />
          </ChatComposerShell>
          ),
        }}
      />
      </div>
      ) : (
        <div
          id={`chat-main-${mainDestination}-panel`}
          className="min-h-0 min-w-0 flex-1 overflow-hidden"
          role="tabpanel"
          aria-labelledby={`chat-main-${mainDestination}-tab`}
          data-chat-destination-page={mainDestination}
          data-chat-destination-scope="main"
        >
          {rightDetailRail}
        </div>
      )}
        </section>
        {senderProfileTarget ? (
          <MemberContactProfilePopover
            participant={senderProfileTarget.participant}
            contacts={cloudContacts.contacts}
            roleLabel="Group member"
            presenceStatus={senderProfileTarget.participant.presenceStatus}
            anchorRect={senderProfileTarget.anchorRect}
            onAddContact={cloudAccount ? cloudContacts.sendRequest : undefined}
            onMessageContact={onMessageContact ? messageTranscriptContact : undefined}
            onClose={() => setSenderProfileTarget(null)}
          />
        ) : null}
        {pinDialog ? (
          <PinMessageDialog
            mode={pinDialog.mode}
            message={pinDialog.message}
            pinForEveryone={pinForEveryone}
            onTogglePinForEveryone={setPinForEveryone}
            onCancel={() => setPinDialog(null)}
            onConfirm={handleConfirmPinDialog}
          />
        ) : null}
        {showCompanionPane && companionSide === 'right' ? splitDivider : null}
        {showCompanionPane && companionSide === 'right' ? companionPane : null}
      </div>
    </div>
  );
}
