import type { CompanionView } from './chatsPage.companionToolbar';
import {useUnreadThreadNavigation} from './useUnreadThreadNavigation';
import {ThreadShortcut} from '@/features/chat/ThreadShortcut';
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { useReducedMotion } from 'framer-motion';

import { suppressLiveTurnEchoMessages } from '@/app/viewModels/helpers';
import type { Conversation, Message } from '@/kordi-app/types';
import { relatedAgentSessionStatusById } from '@/features/chat/relatedAgentSessions';
import { projectQueuedThreadMessages } from '@/features/chat/messageThreads';
import { useThreadMessageSummaries, useThreadTranscript, useActiveThread } from './useThreadMessageSummaries';
import {useThreadReadStatus} from '@/features/cloud/useThreadReadStatus';
import { collapseAdjacentSessionConfigNotices } from '@/features/chat/sessionConfigNotices';
import { isGroupSessionId } from '@/features/chat/forkLineage';
import { cloudCallTargetForConversation } from '@/features/cloud/cloudCalls';
import { useCloudPresence } from '@/features/cloud/useCloudPresence';
import type { ChatsPageProps } from '@/pages/chatsPage.types';
import { ChatCompanionWorkspace } from '@/pages/chatsPage.companionWorkspace';
import { ChatMainWorkspace } from '@/pages/chatsPage.mainWorkspace';
import { chatDiscussionPane } from '@/pages/chatsPage.discussionPane';
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

import { ChatCompanionLayout } from './chatsPage.companionLayout';
import { useCompanionPaneContent } from './useCompanionPaneContent';
import { companionToolbarView, useCompanionPaneTabs } from './useCompanionPaneTabs';
import { useCompanionDocument, useCompanionDocumentRequests } from '@/features/documents/useCompanionDocument';

export * from '@/pages/chatsPage.reexports';
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
    ? cloudPresence.presenceForAccount(activePresenceTarget.peerAccountId)
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
  // Opening a discussion selects its side panel tab; the layout is created below.
  const revealDiscussionRef = useRef(() => {});
  const revealDiscussion = useCallback(() => revealDiscussionRef.current(), []);
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
    onOpen: revealDiscussion,
  });
  const openUnreadRoot=useCallback((rootId:string)=>{setOpenThreadState({conversationId:activeConv.id,rootId});revealDiscussion();},[activeConv.id,revealDiscussion,setOpenThreadState]);
  const unreadThreads=useUnreadThreadNavigation(activeConv,cloudAccount?.accountId,openUnreadRoot,activeThreadRootId);
  // A stable ref keeps the shortcut's onClick identity fixed even though
  // `unreadThreads` is a fresh object every render, so the memoized element
  // below only changes when its visible props actually change (not on every
  // keystroke or unrelated re-render), which lets VirtualTranscript's own
  // memoization see a stable navigationAccessory prop.
  const unreadThreadsRef = useRef(unreadThreads);
  useLayoutEffect(() => { unreadThreadsRef.current = unreadThreads; });
  const handleThreadShortcutClick = useCallback(() => {
    const current = unreadThreadsRef.current;
    void (current.error ? current.retry() : current.load());
  }, []);
  const threadShortcutCount = activeConv.threadAttention?.thread_count ?? 0;
  const threadShortcutElement = useMemo(
    () => (
      <ThreadShortcut
        count={threadShortcutCount}
        busy={unreadThreads.busy}
        error={unreadThreads.error}
        onClick={handleThreadShortcutClick}
      />
    ),
    [threadShortcutCount, unreadThreads.busy, unreadThreads.error, handleThreadShortcutClick],
  );
  const loadedThreadPage=unreadThreads.page;
  const notificationMessage=loadedThreadPage && !loadedThreadPage.isThread?loadedThreadPage.thread.root:undefined;
  const {threadProjection,locatedLiveTurn}=useThreadTranscript(activeConv,activeTranscriptLiveTurn,notificationMessage,loadedThreadPage?.isThread?loadedThreadPage.thread:undefined);
  const activeLiveTurnThreadRootId = locatedLiveTurn && !locatedLiveTurn.completed
    ? threadProjection.threadRootIdByMessageId.get(locatedLiveTurn.replyToMessageId?.trim() ?? '') ?? null
    : null;
  const threadReadStatus = useThreadReadStatus(activeSessionId, cloudAccount?.accountId, threadProjection.threads.size > 0 || Boolean(activeConv.threadAttention?.thread_count));
  const attributedTranscriptMessages = useThreadMessageSummaries(
    threadProjection, threadReadStatus.reads, activeConv.id, activeLiveTurnThreadRootId, openThreadState,
  );
  const localActiveThread=useActiveThread(activeThreadRootId,threadProjection,attributedTranscriptMessages);
  const remoteThread=loadedThreadPage?.isThread?loadedThreadPage.thread:undefined;
  const activeThread=unreadThreads.merge(localActiveThread) ?? (remoteThread?.root.id===activeThreadRootId?remoteThread:null);
  const queuedThreadProjection = useMemo(
    () => projectQueuedThreadMessages(transcript.queuedDesktopMessages, activeThreadRootId, threadProjection.primaryIdByAlias),
    [activeThreadRootId, threadProjection.primaryIdByAlias, transcript.queuedDesktopMessages],
  );
  const mainQueuedMessages = queuedThreadProjection.mainMessages;
  const activeThreadQueuedMessages = queuedThreadProjection.activeThreadMessages;
  const companionDocument = useCompanionDocument(activeConv.id);
  const paneTabs = useCompanionPaneTabs(activeConv.id, companionDocument, companionConversation, Boolean(activeThread));
  const { view: companionView, setView: setCompanionView } = paneTabs;
  const companionLayout = useChatCompanionLayout({
    pageConversationId: activeConv.id,
    hasOverview: companionView !== 'chat',
    onHide: companionSession.actions.cancelCreation,
    activePaneKind,
    companionConversation,
  });
  useCompanionDocumentRequests((document) => { companionDocument.open(document); setCompanionView('document'); companionLayout.placeCompanion('right'); companionLayout.setFolded(false); });
  const {
    containerRef: splitContainerRef,
    side: companionSide,
    isVisible: showCompanionPane,
  } = companionLayout;
  const showDiscussionTab = () => { setCompanionView('discussion'); companionLayout.placeCompanion('right'); companionLayout.setFolded(false); };
  useLayoutEffect(() => { revealDiscussionRef.current = showDiscussionTab; });
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
    setCompanionView('chat');
    if (!canRunOwnAgent()) return false;
    const opened = await companionSession.actions.create(initialPrompt);
    if (!opened) return false;
    companionLayout.placeCompanion('right');
    companionLayout.setFolded(false);
    return opened;
  };
  const openSideAgentPanel = async (initialPrompt = '') => {
    setCompanionView('chat');
    destinations.companion.setValue('messages');
    if (!canRunOwnAgent()) return false;
    const opened = await companionSession.actions.open(initialPrompt);
    if (!opened) return false;
    companionLayout.placeCompanion('right');
    companionLayout.setFolded(false);
    return opened;
  };
  const openRelatedAgentSession = (sessionId: string, isSubsession = false) => {
    setCompanionView('chat');
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
  const selectCompanionView = (requested: CompanionView) => {
    const view = companionToolbarView(requested, Boolean(activeThread));
    if (view === 'discussion') return showDiscussionTab();
    if (view === 'chat' && (!companionConversation || companionConversation.agentSubsessionId)) {
      if (!companionSession.actions.openExisting()) {
        void openSideAgentPanel();
        return;
      }
    }
    setCompanionView(view);
    if (view === 'chat') destinations.companion.showMessages();
    companionLayout.placeCompanion('right');
    companionLayout.setFolded(false);
  };
  const paneContent = useCompanionPaneContent({ documents: companionDocument, tabs: paneTabs, layout: companionLayout, onSelect: selectCompanionView, onCloseDiscussion: closeThread,
    host: { account: cloudAccount, conversation: activeConv, contacts: senderProfiles.contacts, isNativeShell, startChatWithPerson: onMessageContact, forwardMessage: composer.onForwardMessage } });
  return (
    <AgentSubsessionNavigationContext.Provider value={(id) => openRelatedAgentSession(id, true)}>
    <ChatSenderProfileContext.Provider value={senderProfiles.openParticipant}>
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        <ChatCompanionLayout containerRef={splitContainerRef} layout={companionLayout} view={companionView}
          accountId={cloudAccount?.accountId} companionPane={companionPane} openedViews={paneTabs.opened}
          tabBar={paneContent.tabBar} documentPane={paneContent.documentPane} discussionPane={chatDiscussionPane({ activeConv, activeSessionId, activeThread,
            activeThreadRootId, activeLiveTurnThreadRootId, locatedLiveTurn, activeThreadQueuedMessages, activePaneKind, unreadThreads, setOpenThreadState,
            threadReadStatus, routing: collaborationRouting.main, pins: chatPins, runtime, composer, transcript, isNativeShell, accountId: cloudAccount?.accountId,
            openAuthentication, navigateToMessage: transcriptNavigation.main.navigate, openSenderProfile: senderProfiles.openActive, openRelatedAgentSession, handleReplyMessage })}>
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
              toolbar: {
                view: companionView,
                isOpen: showCompanionPane,
                canOpenChat: canOpenSideAgentPanel || companionSession.sessionOptions.some((option) => option.selectable),
                hasChat: Boolean(companionConversation),
                hasDocument: Boolean(companionDocument.document),
                hasTabs: paneTabs.hasTabs,
                hasDiscussion: Boolean(activeThread),
                onToggle: paneContent.toggle,
                onSelect: selectCompanionView,
                onHide: () => companionLayout.setFolded(true),
              },
              open: openSideAgentPanel,
              openSession: openRelatedAgentSession,
            }}
            threadShortcut={threadShortcutElement}
          />
        </ChatCompanionLayout>
      </div>
    </ChatSenderProfileContext.Provider>
    </AgentSubsessionNavigationContext.Provider>
  );
}
