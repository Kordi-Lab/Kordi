import {useUnreadThreadNavigation} from './useUnreadThreadNavigation';
import {ThreadShortcut} from '@/features/chat/ThreadShortcut';
import { useCallback, useMemo, useState } from 'react';
import { useReducedMotion } from 'framer-motion';

import { localOwnedAgentSenderLabel, suppressLiveTurnEchoMessages } from '@/app/viewModels/helpers';
import type { Conversation, Message } from '@/kordi-app/types';
import { relatedAgentSessionStatusById } from '@/features/chat/relatedAgentSessions';
import { projectQueuedThreadMessages, threadRootSource } from '@/features/chat/messageThreads';
import { useThreadMessageSummaries, useThreadTranscript, useActiveThread } from './useThreadMessageSummaries';
import {useThreadReadStatus} from '@/features/cloud/useThreadReadStatus';
import { collapseAdjacentSessionConfigNotices } from '@/features/chat/sessionConfigNotices';
import { isGroupSessionId } from '@/features/chat/forkLineage';
import { cloudCallTargetForConversation } from '@/features/cloud/cloudCalls';
import { useCloudPresence } from '@/features/cloud/useCloudPresence';
import { cn } from '@/lib/utils';
import type { ChatsPageProps } from '@/pages/chatsPage.types';
import {
  ChatCompanionSplitDivider,
  ChatCompanionWorkspace,
} from '@/pages/chatsPage.companionWorkspace';
import { ChatMainWorkspace } from '@/pages/chatsPage.mainWorkspace';
import { ChatThreadPanel } from '@/pages/ChatThreadPanel';
import { useChatThreadSelection } from '@/pages/useChatThreadSelection';
import { useChatCollaborationRouting } from '@/pages/useChatCollaborationRouting';
import { useChatCompanionLayout } from '@/pages/useChatCompanionLayout';
import { useChatCompanionSession } from '@/pages/useChatCompanionSession';
import { AgentSubsessionNavigationContext } from '@/features/cloud/useAgentSubsession';
import { useChatDestinations } from '@/pages/useChatDestinations';
import { useChatForkModel } from '@/pages/useChatForkModel';
import { useChatHeaderModel } from '@/pages/useChatHeaderModel';
import { useChatPins } from '@/pages/useChatPins';
import { ChatSenderProfileContext, useChatSenderProfiles } from '@/pages/useChatSenderProfiles';
import { useChatTranscriptNavigation } from '@/pages/useChatTranscriptNavigation';
import {
  conversationPaneKind,
  shouldSynchronizeConversationModelRoute,
} from '@/pages/chatsPage.model';

export {
  chatHeaderSubtitle,
  isGenericChatHeaderSubtitle,
  localAgentComposerConfigTargetSessionId,
  selfAgentSessionIdForTitleRename,
  shouldUseCompactModelRouteMenu,
} from '@/pages/chatsPage.header';
export {
  PinActivityNotice,
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
} from '@/pages/chatsPage.model';
export { transcriptHumanParticipant } from '@/pages/chatSenderProfileModel';
export {
  COLLABORATION_ROUTING_NOTICE_AUTO_DISMISS_MS,
  COLLABORATION_ROUTING_NOTICE_EXIT_MS,
} from '@/pages/chatsPage.constants';
const EMPTY_CONVERSATIONS: Conversation[] = [];

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
    chatConversations = EMPTY_CONVERSATIONS,
    companionConversations = chatConversations,
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
    setChatComposerTextForSession,
    onReplyMessage: routeReplyMessage,
    activeChatQuote,
    onClearChatQuote,
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
    onSelectSession,
    onForkChatMessage,
    onPrefetchChatSession,
    onSendChatMessage,
    onCreateAgentSession,
  } = runtime;
  const openAuthentication =
    auth.onOpenAccountAuthentication ?? auth.onOpenAuthSettings;
  const canRunOwnAgent = () => { if (auth.hasAnyAuth) return true; openAuthentication(); return false; };
  const visibleDesktopLiveTurn = desktopLiveTurn ?? (!isNativeShell ? activeConv.previewLiveTurn ?? null : null);
  const isCompressionActive = visibleDesktopLiveTurn?.status === 'compacting';
  const activeLiveTurnIsRunning = Boolean(
    desktopLiveTurn && desktopLiveTurn.sessionId === activeConv.id && !desktopLiveTurn.completed,
  );
  const backgroundSessionStatusById = useMemo(
    () => relatedAgentSessionStatusById(companionConversations),
    [companionConversations],
  );
  const cloudPresence = useCloudPresence(cloudAccount);
  const activePresenceTarget = cloudAccount
    ? cloudCallTargetForConversation(cloudAccount, activeConv)
    : null;
  const activeContactPresence = activePresenceTarget?.kind === 'direct'
    ? cloudPresence.snapshot[activePresenceTarget.peerAccountId] ?? null
    : undefined;
  const chatHeader = useChatHeaderModel({
    contactPresence: activeContactPresence,
    isNativeShell,
    isSending: isDesktopChatSending,
    session,
  });
  const activeTranscriptLiveTurn = visibleDesktopLiveTurn?.sessionId === activeConv.id ? visibleDesktopLiveTurn : undefined;
  const prefersReducedMotion = useReducedMotion();
  const activeSessionId = (activeConv.canonicalSessionId || activeConv.id).trim();
  const activeConversationIsGroupSession = isGroupSessionId(activeSessionId);
  const activePaneKind = conversationPaneKind(activeConv);
  const sessionRouteSyncEnabled = shouldSynchronizeConversationModelRoute({
    conversation: activeConv,
    usesCollaborationTransport: activeConversationUsesCollaboration,
    hasCloudAccount: Boolean(cloudAccount),
    hasModelHost: Boolean(activeCollaborationModelHost),
  });
  const companionSession = useChatCompanionSession({
    activeConversation: activeConv,
    conversations: chatConversations,
    directConversations: companionConversations,
    activePaneKind,
    setComposerTextForSession: setChatComposerTextForSession,
    onSendChatMessage,
    onCreateAgentSession,
    onPrefetchChatSession,
    canRunOwnAgent,
  });
  const companionConversation = companionSession.conversation;
  const suggestedSideAgentConversation = companionSession.suggested;
  const companionOpenComposerSelector = companionSession.selector.value;
  const setCompanionOpenComposerSelector = companionSession.selector.set;
  const senderProfiles = useChatSenderProfiles({
    activeConversation: activeConv,
    companionConversation,
    participantSpaces: session.participantSpaces,
    cloudAccount,
    presenceSnapshot: cloudPresence.snapshot,
    onMessageContact,
    onSelectSession,
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
  const companionConversationIsCollaborationAgent = Boolean(!companionConversation?.agentSubsessionId && companionPaneKind === 'agent' && companionConversationUsesCollaborationTransport);
  const companionShowsLocalAgentControls = !companionConversation?.agentSubsessionId && companionPaneKind === 'agent' && !companionConversationIsCollaborationAgent;
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
      enabled: sessionRouteSyncEnabled,
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
    activeThreadRootId,
    closeThread,
    openThread,
    openThreadState,
    replyToMessage: handleReplyMessage,
    setOpenThreadState,
  } = useChatThreadSelection({
    conversationId: activeConv.id,
    sessionId: activeSessionId,
    activeReplyAction: activeChatQuote?.action,
    isNativeShell,
    routeReplyMessage,
    clearReply: onClearChatQuote,
  });
  const openUnreadRoot=useCallback((rootId:string)=>setOpenThreadState({conversationId:activeConv.id,rootId}),[activeConv.id,setOpenThreadState]);
  const unreadThreads=useUnreadThreadNavigation(activeConv,cloudAccount?.accountId,openUnreadRoot,activeThreadRootId);
  const loadedThreadPage=unreadThreads.page;
  const notificationMessage=loadedThreadPage && !loadedThreadPage.isThread?loadedThreadPage.thread.root:undefined;
  const {threadProjection,locatedLiveTurn}=useThreadTranscript(activeConv,activeTranscriptLiveTurn,notificationMessage);
  const activeLiveTurnThreadRootId = locatedLiveTurn && !locatedLiveTurn.completed
    ? threadProjection.threadRootIdByMessageId.get(locatedLiveTurn.replyToMessageId?.trim() ?? '') ?? null
    : null;
  const threadReadStatus = useThreadReadStatus(activeSessionId, cloudAccount?.accountId, threadProjection.threads.size > 0 || Boolean(activeConv.threadAttention?.thread_count));
  const attributedTranscriptMessages = useThreadMessageSummaries(
    threadProjection, threadReadStatus.reads, activeConv.id, activeLiveTurnThreadRootId, openThreadState,
  );
  const [threadPanelWidth, setThreadPanelWidth] = useState(384);
  const localActiveThread=useActiveThread(activeThreadRootId,threadProjection,attributedTranscriptMessages);
  const remoteThread=loadedThreadPage?.isThread?loadedThreadPage.thread:undefined;
  const activeThread=unreadThreads.merge(localActiveThread) ?? (remoteThread?.root.id===activeThreadRootId?remoteThread:null);
  const queuedThreadProjection = useMemo(
    () => projectQueuedThreadMessages(transcript.queuedDesktopMessages, activeThreadRootId, threadProjection.primaryIdByAlias),
    [activeThreadRootId, threadProjection.primaryIdByAlias, transcript.queuedDesktopMessages],
  );
  const mainQueuedMessages = queuedThreadProjection.mainMessages;
  const activeThreadQueuedMessages = queuedThreadProjection.activeThreadMessages;
  const chatForkModel = useChatForkModel({
    conversation: activeConv,
    messages: attributedTranscriptMessages,
    desktopChatState,
    isGroupSession: activeConversationIsGroupSession,
    isAgentSession: activeConv.type === 'owned-agent' || activeConv.type === 'external-agent',
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
      notificationMessage,
      onNotificationNavigation: closeThread,
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
    currentAccountId: cloudAccount?.accountId,
    cloudPin: cloudSessionPin,
    onUpdateCloudPin: onUpdateCloudSessionPin,
    onNavigateToMessage: transcriptNavigation.main.navigate,
  });
  const createSideAgentSession = async (initialPrompt = '') => {
    if (!canRunOwnAgent()) return false;
    const opened = await companionSession.actions.create(initialPrompt);
    if (!opened) return false;
    companionLayout.placeCompanion('right');
    companionLayout.setFolded(false);
    return opened;
  };
  const openSideAgentPanel = async (initialPrompt = '') => {
    if (!canRunOwnAgent()) return false;
    const opened = await companionSession.actions.open(initialPrompt);
    if (!opened) return false;
    companionLayout.placeCompanion('right');
    companionLayout.setFolded(false);
    return opened;
  };
  const openRelatedAgentSession = (sessionId: string, isSubsession = false) => {
    if (isSubsession) companionSession.actions.openSubsession(sessionId);
    else companionSession.actions.switchConversation(sessionId);
    destinations.companion.setValue('messages');
    companionLayout.placeCompanion('right');
    companionLayout.setFolded(false);
  };
  const companionPane = companionConversation ? (
    <ChatCompanionWorkspace
      key={companionConversation.id}
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
        relatedAgentSessionStatusById: backgroundSessionStatusById,
      }}
      shell={{
        isNativeShell,
        openAuthentication,
        openSession: openRelatedAgentSession,
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
    <AgentSubsessionNavigationContext.Provider value={(id) => openRelatedAgentSession(id, true)}>
    <ChatSenderProfileContext.Provider value={senderProfiles.openParticipant}>
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        <div
          ref={splitContainerRef}
          className={cn(
            'app-chat-split-workspace relative min-h-0 flex-1 overflow-hidden',
            chatSplitGridColumns && 'grid',
            isDraggingCompanion && 'ring-1 ring-sky-300/25',
            companionDropPreviewSide === 'left' && 'bg-gradient-to-r from-sky-400/10 via-transparent to-transparent',
            companionDropPreviewSide === 'right' && 'bg-gradient-to-l from-sky-400/10 via-transparent to-transparent',
          )}
          style={chatSplitGridColumns ? { gridTemplateColumns: chatSplitGridColumns } : undefined}
          data-chat-companion-side={showCompanionPane ? companionSide : 'folded'}
          data-chat-split-workspace="true"
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
            transcript={{ ...transcript, queuedDesktopMessages: mainQueuedMessages }}
            composer={{
              ...composer,
              activeChatQuote: activeChatQuote?.action === 'thread' ? null : activeChatQuote,
              onReplyMessage: handleReplyMessage,
              onOpenMessageThread: openThread,
            }}
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
              liveTurn: activeLiveTurnThreadRootId ? undefined : locatedLiveTurn,
              isCompressionActive,
              activeLiveTurnIsRunning,
              prefersReducedMotion,
              relatedAgentSessionStatusById: backgroundSessionStatusById,
              showCompanionPane,
              activeSide: companionSide === 'left' ? 'right' : 'left',
            }}
            companion={{
              canOpen: canOpenSideAgentPanel,
              suggestedName: suggestedSideAgentConversation?.name,
              open: openSideAgentPanel,
              openSession: openRelatedAgentSession,
            }}
            threadShortcut={<ThreadShortcut count={activeConv.threadAttention?.thread_count??0} busy={unreadThreads.busy} error={unreadThreads.error} onClick={()=>void (unreadThreads.error?unreadThreads.retry():unreadThreads.load())}/>}
            threadPanel={activeThread ? (
              <ChatThreadPanel
                conversation={activeConv}
                thread={activeThread}
                navigationMessageId={loadedThreadPage?.target}
                firstUnreadMessageId={loadedThreadPage?.first}
                nextAfterSequence={loadedThreadPage?.next}
                onLoadMore={()=>void unreadThreads.load(activeThread.root.id,loadedThreadPage?.next??undefined)}
                onNextUnread={()=>void unreadThreads.load()}
                unreadThreadCount={activeConv.threadAttention?.thread_count??0}
                replyCount={Math.max(
                  activeThread.replies.length + Number(activeLiveTurnThreadRootId === activeThreadRootId),
                  activeThreadQueuedMessages.length,
                  openThreadState?.optimisticReplyCount ?? 0,
                )}
                liveTurn={activeLiveTurnThreadRootId === activeThreadRootId ? locatedLiveTurn : null}
                liveTurnSender={localOwnedAgentSenderLabel(activeConv)}
                onClose={closeThread}
                onSendStart={() => setOpenThreadState((current) => current ? ({
                  ...current,
                  optimisticReplyCount: Math.max(
                    current.optimisticReplyCount ?? 0,
                    activeThread.replies.length + activeThreadQueuedMessages.length + 1,
                  ),
                }) : current)}
                onSendSettled={() => setOpenThreadState((current) => current ? ({
                  ...current,
                  optimisticReplyCount: undefined,
                }) : current)}
                onSend={(text, attachments) => {
                  const source = threadRootSource(activeThread.root, activeSessionId);
                  if (!source) return;
                  return runtime.onSendChatMessage(
                    text,
                    undefined,
                    undefined,
                    attachments,
                    { action: 'thread', source },
                  );
                }}
                saveAttachments={composer.saveDesktopAttachments}
                saveAttachmentPaths={composer.saveDesktopAttachmentPaths}
                removeStagedAttachment={composer.removeChatComposerAttachment}
                isNativeShell={isNativeShell}
                accountId={cloudAccount?.accountId}
                readCursors={threadReadStatus.reads}
                onMarkRead={threadReadStatus.markRead}
                queuedMessages={activeThreadQueuedMessages}
                onCancelQueuedMessage={transcript.onCancelQueuedMessage}
                width={threadPanelWidth}
                onWidthChange={setThreadPanelWidth}
                compactModelMenu={{
                  selection: collaborationRouting.main.enabled && collaborationRouting.main.selectedAgent
                    ? collaborationRouting.main.selection ?? composerSelection
                    : composerSelection,
                  providerOptions: composerProviderOptions,
                  modelOptions: chatModelOptions && chatModelOptions.length > 0
                    ? chatModelOptions
                    : undefined,
                  onSave: collaborationRouting.main.saveCompactRoute,
                }}
                chatMentionTargetsForText={composer.chatMentionTargetsForText}
                actions={{
                  onOpenSource: transcript.onOpenSource,
                  onOpenArtifact: transcript.onOpenArtifact,
                  onOpenAuthSettings: openAuthentication,
                  onNavigateToMessage: transcriptNavigation.main.navigate,
                  onOpenMessageDetail: composer.onSelectMessage,
                  onStopCollaborationAgentRequest: runtime.onStopCollaborationAgentRequest,
                  onStopActiveTurn: runtime.onStopDesktopChatTurn,
                  onRequestCollaborationContact: runtime.onRequestCollaborationContact,
                  onOpenSenderProfile: senderProfiles.openActive,
                  onOpenForkSession: openRelatedAgentSession,
                  onReplyMessage: handleReplyMessage,
                  onForwardMessage: composer.onForwardMessage,
                  onEditMessage: composer.onEditMessage,
                  onDeleteMessage: composer.onDeleteMessage,
                  onReactMessage: composer.onReactMessage,
                  onRetryMessage: runtime.onRetryChatMessage,
                  onSelectMessage: composer.onSelectMessage,
                  onRequestPinMessage: chatPins.requestPin,
                  onRequestUnpinMessage: chatPins.requestUnpin,
                }}
              />
            ) : null}
          />
          {showCompanionPane && companionSide === 'right' ? splitDivider : null}
          {showCompanionPane && companionSide === 'right' ? companionPane : null}
        </div>
      </div>
    </ChatSenderProfileContext.Provider>
    </AgentSubsessionNavigationContext.Provider>
  );
}
