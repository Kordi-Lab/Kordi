import { useMemo } from 'react';
import { useReducedMotion } from 'framer-motion';

import { suppressLiveTurnEchoMessages } from '@/app/viewModels/helpers';
import type { Message } from '@/kordi-app/types';
import { collapseAdjacentSessionConfigNotices } from '@/features/chat/sessionConfigNotices';
import { isGroupForkSession, isGroupSessionId } from '@/features/chat/forkLineage';
import { cn } from '@/lib/utils';
import type { ChatsPageProps } from '@/pages/chatsPage.types';
import {
  ChatCompanionSplitDivider,
  ChatCompanionWorkspace,
} from '@/pages/chatsPage.companionWorkspace';
import { ChatMainWorkspace } from '@/pages/chatsPage.mainWorkspace';
import { useChatCollaborationRouting } from '@/pages/useChatCollaborationRouting';
import { useChatCompanionLayout } from '@/pages/useChatCompanionLayout';
import { useChatCompanionSession } from '@/pages/useChatCompanionSession';
import { useChatDestinations } from '@/pages/useChatDestinations';
import { useChatForkModel } from '@/pages/useChatForkModel';
import { useChatHeaderModel } from '@/pages/useChatHeaderModel';
import { useChatPins } from '@/pages/useChatPins';
import { useChatSenderProfiles } from '@/pages/useChatSenderProfiles';
import { useChatTranscriptNavigation } from '@/pages/useChatTranscriptNavigation';
import { conversationPaneKind } from '@/pages/chatsPage.model';

export {
  chatHeaderSubtitle,
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
    isDetailPanelCollapsed,
    setIsDetailPanelCollapsed,
    activeDetailTab,
    setActiveDetailTab,
  } = layout;
  const {
    activeConv,
    chatConversations,
    activeConversationUsesCollaboration,
    activeCollaborationModelHost,
    desktopChatState,
    cloudAccount = null,
    cloudSessionPin,
    onUpdateCloudSessionPin,
    onUpdateCollaborationAgentModelRouting,
  } = session;
  const {
    onClearSourcePreview,
    desktopLiveTurn,
  } = transcript;
  const {
    chatComposerAttachments,
    setChatComposerTextForSession,
  } = composer;
  const {
    composerSelection,
    openComposerSelector,
    toggleComposerSelector,
    selectComposerValue,
    selectComposerProviderChoice,
    composerProviderOptions,
    chatModelOptions,
    isDesktopChatSending,
    onMessageContact,
    onForkChatMessage,
    onSendChatMessage,
    onCreateAgentSession,
  } = runtime;
  const openAuthentication =
    auth.onOpenAccountAuthentication ?? auth.onOpenAuthSettings;
  const visibleDesktopLiveTurn = desktopLiveTurn ?? (!isNativeShell ? activeConv.previewLiveTurn ?? null : null);
  const isCompressionActive = visibleDesktopLiveTurn?.status === 'compacting';
  const activeLiveTurnIsRunning = Boolean(
    desktopLiveTurn && desktopLiveTurn.sessionId === activeConv.id && !desktopLiveTurn.completed,
  );
  const chatHeader = useChatHeaderModel({
    isNativeShell,
    isSending: isDesktopChatSending,
    session,
  });
  const activeTranscriptLiveTurn = visibleDesktopLiveTurn?.sessionId === activeConv.id ? visibleDesktopLiveTurn : undefined;
  const prefersReducedMotion = useReducedMotion();
  const activeSessionId = (activeConv.canonicalSessionId || activeConv.id).trim();
  const activeConversationIsGroupSession = isGroupSessionId(activeSessionId);
  const activeConversationIsGroupFork = isGroupForkSession(activeConv);
  const activePaneKind = conversationPaneKind(activeConv);
  const companionSession = useChatCompanionSession({
    activeConversation: activeConv,
    conversations: chatConversations,
    activePaneKind,
    attachmentCount: chatComposerAttachments.length,
    setComposerTextForSession: setChatComposerTextForSession,
    onSendChatMessage,
    onCreateAgentSession,
  });
  const companionConversation = companionSession.conversation;
  const suggestedSideAgentConversation = companionSession.suggested;
  const companionOpenComposerSelector = companionSession.selector.value;
  const setCompanionOpenComposerSelector = companionSession.selector.set;
  const senderProfiles = useChatSenderProfiles({
    activeConversation: activeConv,
    companionConversation,
    cloudAccount,
    onMessageContact,
  });
  const destinations = useChatDestinations({
    main: {
      conversationId: activeConv.id,
      activeDetailTab,
      isDetailPanelCollapsed,
      setActiveDetailTab,
      setIsDetailPanelCollapsed,
      onClearSourcePreview,
    },
    companionConversationId: companionConversation?.id ?? null,
  });
  const companionLayout = useChatCompanionLayout({
    pageConversationId: activeConv.id,
    activePaneKind,
    companionConversation,
  });
  const {
    side: companionSide,
    isVisible: showCompanionPane,
    isDragging: isDraggingCompanion,
    dropPreviewSide: companionDropPreviewSide,
    containerRef: splitContainerRef,
    gridColumns: chatSplitGridColumns,
    onDragOver: handleCompanionDragOver,
    onDrop: handleCompanionDrop,
  } = companionLayout;
  const canOpenSideAgentPanel = companionSession.canOpen;
  const companionPaneKind = companionConversation ? conversationPaneKind(companionConversation) : null;
  const companionConversationUsesCollaborationTransport = companionConversation?.collaborationSources.some((source) => source.trim().toLowerCase() !== 'local') ?? false;
  const companionConversationIsCollaborationAgent = Boolean(companionPaneKind === 'agent' && companionConversationUsesCollaborationTransport);
  const companionShowsLocalAgentControls = companionPaneKind === 'agent' && !companionConversationIsCollaborationAgent;
  const rawCompanionTranscriptLiveTurn = companionConversation?.previewLiveTurn ?? undefined;
  const companionTranscriptLiveTurn = rawCompanionTranscriptLiveTurn && companionConversation && rawCompanionTranscriptLiveTurn.sessionId === companionConversation.id
    ? rawCompanionTranscriptLiveTurn
    : undefined;
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
  const transcriptMessages = collapseAdjacentSessionConfigNotices(
    suppressLiveTurnEchoMessages(activeConv.messages, activeTranscriptLiveTurn),
  );
  const attributedTranscriptMessages = transcriptMessages;
  const chatForkModel = useChatForkModel({
    conversation: activeConv,
    messages: attributedTranscriptMessages,
    desktopChatState,
    isGroupSession: activeConversationIsGroupSession,
    isGroupFork: activeConversationIsGroupFork,
    onForkMessage: onForkChatMessage,
  });
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
      onShowMessages: destinations.companion.showMessages,
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
  const createSideAgentSession = async (initialPrompt = '') => {
    const opened = await companionSession.actions.create(initialPrompt);
    if (!opened) return false;
    companionLayout.placeCompanion('right');
    companionLayout.setFolded(false);
    return opened;
  };
  const openSideAgentPanel = async (initialPrompt = '') => {
    const opened = await companionSession.actions.open(initialPrompt);
    if (!opened) return false;
    companionLayout.placeCompanion('right');
    companionLayout.setFolded(false);
    return opened;
  };
  const companionPane = companionConversation ? (
    <ChatCompanionWorkspace
      session={companionSession}
      layoutModel={companionLayout}
      destinations={destinations.companion}
      routing={collaborationRouting.companion}
      navigation={transcriptNavigation.companion}
      senderProfiles={senderProfiles}
      presentation={{
        messages: companionTranscriptMessages,
        liveTurn: companionTranscriptLiveTurn,
        isCollaborationAgent: companionConversationIsCollaborationAgent,
        showsLocalAgentControls: companionShowsLocalAgentControls,
        prefersReducedMotion,
      }}
      shell={{
        isNativeShell,
        openAuthentication,
        onCreateSession: () => {
          void createSideAgentSession();
        },
      }}
      layout={layout}
      transcript={transcript}
      composer={composer}
      runtime={runtime}
    />
  ) : null;
  const splitDivider = <ChatCompanionSplitDivider layoutModel={companionLayout} />;
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
            companionLayout.clearDropPreview();
          }
        }}
      >
        {showCompanionPane && companionSide === 'left' ? companionPane : null}
        {showCompanionPane && companionSide === 'left' ? splitDivider : null}
        <ChatMainWorkspace
          layout={layout}
          session={session}
          transcript={transcript}
          composer={composer}
          runtime={runtime}
          auth={auth}
          models={{
            header: chatHeader,
            destinations: destinations.main,
            fork: chatForkModel,
            pins: chatPins,
            navigation: transcriptNavigation.main,
            routing: collaborationRouting.main,
            senderProfiles,
          }}
          presentation={{
            messages: attributedTranscriptMessages,
            liveTurn: activeTranscriptLiveTurn,
            isCompressionActive,
            activeLiveTurnIsRunning,
            prefersReducedMotion,
            showCompanionPane,
            activeSide: companionSide === 'left' ? 'right' : 'left',
          }}
          companion={{
            canOpen: canOpenSideAgentPanel,
            suggestedName: suggestedSideAgentConversation?.name,
            open: openSideAgentPanel,
          }}
        />
        {showCompanionPane && companionSide === 'right' ? splitDivider : null}
        {showCompanionPane && companionSide === 'right' ? companionPane : null}
      </div>
    </div>
  );
}
