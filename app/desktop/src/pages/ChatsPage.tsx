import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, PointerEvent as ReactPointerEvent } from 'react';
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
import type { CloudSelfAgentSyncStatus } from '@/features/cloud/useCloudCollaborationState';
import { useCloudContacts } from '@/features/cloud/useCloudContacts';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { localOwnedAgentSenderLabel, suppressLiveTurnEchoMessages } from '@/app/viewModels/helpers';
import type {
  Contact,
  Conversation,
  ConversationParticipant,
  EditFilePreview,
  Message,
} from '@/kordi-app/types';
import { chatComposerPlaceholder } from '@/features/chat/composerCopy';
import { shouldInferLatestHumanReplyTarget, shouldSuppressAgentReplyAttribution } from '@/features/chat/replyAttribution';
import { collapseAdjacentSessionConfigNotices } from '@/features/chat/sessionConfigNotices';
import type { TranscriptDensityMode } from '@/kordi-app/components/transcript';
import { LOCAL_DRAFT_CHAT_CONVERSATION_ID } from '@/features/chat/draftSessions';
import { isGroupForkSession, isGroupSessionId } from '@/features/chat/forkLineage';
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
import { CompanionHeader } from '@/pages/chatsPage.companionHeader';
import { CompanionPane } from '@/pages/chatsPage.companionPane';
import { MainComposer } from '@/pages/chatsPage.mainComposer';
import { MainChatHeader } from '@/pages/chatsPage.mainHeader';
import { useChatCollaborationRouting } from '@/pages/useChatCollaborationRouting';
import { useChatForkModel } from '@/pages/useChatForkModel';
import { useChatPins } from '@/pages/useChatPins';
import { useChatTranscriptNavigation } from '@/pages/useChatTranscriptNavigation';
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
  ChatComposerShell,
  ChatSessionPane,
  SessionStartingState,
} from '@/pages/chatsPage.sessionPane';
import {
  CHAT_COMPANION_DRAG_TYPE,
  buildAskAgentSessionReferenceContext,
  buildAskAgentSessionReferenceContextMessage,
  canonicalHistorySessionIdForConversation,
  chatCompanionCandidates,
  chatCompanionSideForPaneKinds,
  chatCompanionSideFromDropPosition,
  chatSideAgentConversationForOpenRequest,
  chatTranscriptDensityMode,
  clampChatSplitFraction,
  conversationPaneKind,
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
  const collaborationRouting = useChatCollaborationRouting({
    shared: {
      desktopChatState,
      modelOptions: chatModelOptions,
      providerOptions: composerProviderOptions,
      updateRouting: onUpdateCollaborationAgentModelRouting,
    },
    main: {
      conversation: activeConv,
      host: activeCollaborationModelHost,
      enabled: activeConversationUsesCollaboration,
      isBusy: isDesktopChatSending || activeLiveTurnIsRunning,
      openSelector: openComposerSelector,
      toggleSelector: toggleComposerSelector,
      composerSelection,
      selectComposerProviderChoice,
      selectComposerValue,
    },
    companion: {
      conversation: companionConversation,
      host: companionCollaborationModelHost,
      enabled: companionConversationIsCollaborationAgent,
      isBusy: isDesktopChatSending || Boolean(
        companionTranscriptLiveTurn && !companionTranscriptLiveTurn.completed,
      ),
      openSelector: companionOpenComposerSelector,
      setOpenSelector: setCompanionOpenComposerSelector,
    },
  });
  const {
    notice: collaborationRoutingNotice,
    agents: collaborationRoutingAgents,
    selectedAgent: selectedCollaborationRoutingAgent,
    selection: collaborationRoutingSelection,
    visibility: collaborationRoutingControlVisibility,
    selectorOpen: collaborationAgentSelectorOpen,
    setSelectedAgentId: setSelectedCollaborationAgentId,
    update: updateCollaborationAgentRouting,
    saveCompactRoute: saveCompactModelRoute,
    defaultThinkingForModel: defaultThinkingForCollaborationModel,
  } = collaborationRouting.main;
  const {
    notice: companionCollaborationRoutingNotice,
    agents: companionCollaborationRoutingAgents,
    selectedAgent: selectedCompanionCollaborationRoutingAgent,
    selection: companionCollaborationRoutingSelection,
    visibility: companionCollaborationRoutingControlVisibility,
    selectorOpen: companionCollaborationAgentSelectorOpen,
    setSelectedAgentId: setSelectedCompanionCollaborationAgentId,
    update: updateCompanionCollaborationAgentRouting,
    defaultThinkingForModel: companionDefaultThinkingForCollaborationModel,
  } = collaborationRouting.companion;

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

  const transcriptMessages = collapseAdjacentSessionConfigNotices(
    suppressLiveTurnEchoMessages(activeConv.messages, activeTranscriptLiveTurn),
  );
  const inferLatestHumanReplyTarget = shouldInferLatestHumanReplyTarget(activeConv);
  const suppressAgentReplyAttribution = shouldSuppressAgentReplyAttribution(activeConv);
  const attributedTranscriptMessages = transcriptMessages;
  const chatForkModel = useChatForkModel({
    conversation: activeConv,
    messages: attributedTranscriptMessages,
    desktopChatState,
    isGroupSession: activeConversationIsGroupSession,
    isGroupFork: activeConversationIsGroupFork,
    onForkMessage: onForkChatMessage,
  });
  const {
    sourceSessionId: activeForkSourceSessionId,
    sourceTitle: activeForkSourceTitle,
    forksByEntryId: messageForksByEntryId,
    snapshotBoundaryIndex: forkSnapshotBoundaryIndex,
    forkMessage: handleForkMessage,
  } = chatForkModel;
  const companionTranscriptMessages = useMemo(() => {
    if (!companionConversation) return [] as Message[];
    return collapseAdjacentSessionConfigNotices(
      suppressLiveTurnEchoMessages(companionConversation.messages, companionTranscriptLiveTurn),
    );
  }, [companionConversation, companionTranscriptLiveTurn]);
  const transcriptNavigation = useChatTranscriptNavigation({
    main: {
      conversation: activeConv,
      messages: attributedTranscriptMessages,
    },
    companion: {
      conversation: companionConversation,
      messages: companionTranscriptMessages,
      onShowMessages: () => {
        setCompanionActiveSourcePreview(null);
        setCompanionDestination('messages');
      },
    },
  });
  const chatPins = useChatPins({
    conversation: activeConv,
    messages: attributedTranscriptMessages,
    sessionId: activeSessionId,
    isGroupSession: activeConversationIsGroupSession,
    cloudPin: cloudSessionPin,
    onUpdateCloudPin: onUpdateCloudSessionPin,
    onNavigateToMessage: transcriptNavigation.main.navigate,
  });
  const {
    pinnedMessageId,
    pinnedMessage,
    requestPin: requestPinMessage,
    requestUnpin: requestUnpinMessage,
    openPinnedMessage: handleOpenPinnedMessage,
  } = chatPins;
  const attributedActiveTranscriptLiveTurn = activeTranscriptLiveTurn;
  const shouldRenderLiveTurn = Boolean(attributedActiveTranscriptLiveTurn && !attributedActiveTranscriptLiveTurn.completed);
  const attributedCompanionTranscriptLiveTurn = companionTranscriptLiveTurn;
  const shouldRenderCompanionLiveTurn = Boolean(attributedCompanionTranscriptLiveTurn && !attributedCompanionTranscriptLiveTurn.completed);
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
        onNavigateToResponse: transcriptNavigation.companion.navigate,
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
          onNavigateToMessage: transcriptNavigation.companion.navigate,
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
          navigationRequest: transcriptNavigation.companion.request,
          onNavigationHandled: transcriptNavigation.companion.acknowledge,
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
          onNavigateToMessage: transcriptNavigation.main.navigate,
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
          navigationRequest: transcriptNavigation.main.request,
          onNavigationHandled: transcriptNavigation.main.acknowledge,
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
        {chatPins.dialog.value ? (
          <PinMessageDialog
            mode={chatPins.dialog.value.mode}
            message={chatPins.dialog.value.message}
            pinForEveryone={chatPins.dialog.pinForEveryone}
            onTogglePinForEveryone={chatPins.dialog.setPinForEveryone}
            onCancel={chatPins.dialog.cancel}
            onConfirm={chatPins.dialog.confirm}
          />
        ) : null}
        {showCompanionPane && companionSide === 'right' ? splitDivider : null}
        {showCompanionPane && companionSide === 'right' ? companionPane : null}
      </div>
    </div>
  );
}
