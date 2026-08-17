import { AuthNoticeBanner } from '@/components/AuthNoticeBanner';
import {
  localOwnedAgentSenderLabel,
} from '@/app/viewModels/helpers';
import { chatComposerPlaceholder } from '@/features/chat/composerCopy';
import type { AttachmentItem } from '@/features/chat/composerController.types';
import { isEmptyChatSelectionId } from '@/features/chat/draftSessions';
import {
  shouldInferLatestHumanReplyTarget,
  shouldSuppressAgentReplyAttribution,
} from '@/features/chat/replyAttribution';
import type {
  DesktopChatTurnSnapshot,
  Message,
} from '@/kordi-app/types';
import { MemberContactProfilePopover } from '@/pages/MemberContactProfilePopover';
import { MainComposer } from '@/pages/chatsPage.mainComposer';
import { MainChatHeader } from '@/pages/chatsPage.mainHeader';
import {
  canonicalHistorySessionIdForConversation,
  chatTranscriptDensityMode,
  conversationPaneKind,
  localAgentConversationNeedsProvider,
  parseAskAgentTriggerCommand,
} from '@/pages/chatsPage.model';
import {
  localAgentComposerConfigTargetSessionId,
  scheduleTranscriptScrollToBottom,
} from '@/pages/chatsPage.header';
import {
  PinMessageDialog,
  PinnedMessageBar,
} from '@/pages/chatsPage.pins';
import {
  ChatComposerShell,
  ChatSelectionEmptyState,
  ChatSessionPane,
  SessionStartingState,
} from '@/pages/chatsPage.sessionPane';
import type {
  ChatsPageAuth,
  ChatsPageComposer,
  ChatsPageLayout,
  ChatsPageRuntime,
  ChatsPageSession,
  ChatsPageTranscript,
} from '@/pages/chatsPage.types';
import type { useChatCollaborationRouting } from '@/pages/useChatCollaborationRouting';
import type { useChatDestinations } from '@/pages/useChatDestinations';
import type { useChatForkModel } from '@/pages/useChatForkModel';
import type { useChatHeaderModel } from '@/pages/useChatHeaderModel';
import type { useChatPins } from '@/pages/useChatPins';
import type { useChatSenderProfiles } from '@/pages/useChatSenderProfiles';
import type { useChatTranscriptNavigation } from '@/pages/useChatTranscriptNavigation';
import { SupportConversationEmptyState } from '@/features/support/SupportReportDialog';
import { SupportReportSubmissionProvider } from '@/features/support/SupportReportSubmissionContext';
import { ConversationCallBanner } from '@/features/cloud/ConversationCallBanner';

type ChatMainWorkspaceProps = {
  layout: ChatsPageLayout;
  session: ChatsPageSession;
  transcript: ChatsPageTranscript;
  composer: ChatsPageComposer;
  runtime: ChatsPageRuntime;
  auth: ChatsPageAuth;
  models: {
    header: ReturnType<typeof useChatHeaderModel>;
    destinations: ReturnType<typeof useChatDestinations>['main'];
    fork: ReturnType<typeof useChatForkModel>;
    pins: ReturnType<typeof useChatPins>;
    navigation: ReturnType<typeof useChatTranscriptNavigation>['main'];
    routing: ReturnType<typeof useChatCollaborationRouting>['main'];
    senderProfiles: ReturnType<typeof useChatSenderProfiles>;
  };
  presentation: {
    messages: readonly Message[];
    liveTurn?: DesktopChatTurnSnapshot | null;
    isCompressionActive: boolean;
    activeLiveTurnIsRunning: boolean;
    prefersReducedMotion: boolean | null;
    showCompanionPane: boolean;
    activeSide: 'left' | 'right';
  };
  companion: {
    canOpen: boolean;
    suggestedName?: string;
    open: (initialPrompt?: string) => Promise<boolean>;
  };
};

export function ChatMainWorkspace({
  layout,
  session,
  transcript,
  composer,
  runtime,
  auth,
  models,
  presentation,
  companion,
}: ChatMainWorkspaceProps) {
  const { activeConv } = session;
  const openAuthentication =
    auth.onOpenAccountAuthentication ?? auth.onOpenAuthSettings;
  const activePaneKind = conversationPaneKind(activeConv);
  const isEmptySelection = isEmptyChatSelectionId(activeConv.id);
  const needsProvider = localAgentConversationNeedsProvider({
    activePaneKind,
    activeConversationUsesCollaboration:
      session.activeConversationUsesCollaboration,
    hasAnyAuth: auth.hasAnyAuth,
  });
  const canonicalHistorySessionId =
    canonicalHistorySessionIdForConversation(activeConv);
  const localConfigTargetSessionId =
    localAgentComposerConfigTargetSessionId(activeConv);
  const liveTurnSender = localOwnedAgentSenderLabel(activeConv);
  const supportReportSessionId = activeConv.supportTicketEnabled
    ? canonicalHistorySessionId ?? activeConv.id
    : undefined;
  const submitSupportReport = activeConv.supportTicketEnabled
    ? models.senderProfiles.submitSupportRequest
    : undefined;
  const getSupportReport = activeConv.supportTicketEnabled
    ? models.senderProfiles.getSupportRequest
    : undefined;
  const supportAccountId = activeConv.supportTicketEnabled
    ? models.senderProfiles.supportAccountId
    : undefined;
  const shouldRenderLiveTurn = Boolean(
    presentation.liveTurn && !presentation.liveTurn.completed,
  );
  const handleSend = (draftOverride?: string, attachmentOverride?: AttachmentItem[]) => {
    const draft = draftOverride ?? composer.chatComposerText;
    const attachmentCount = attachmentOverride?.length ?? composer.chatComposerAttachments.length;
    if (
      needsProvider
      && (
        draft.trim().length > 0
        || attachmentCount > 0
      )
    ) {
      openAuthentication?.();
      return;
    }
    const trigger = parseAskAgentTriggerCommand(draft);
    if (trigger) {
      void companion.open(trigger.prompt).then((opened) => {
        if (opened) composer.setChatComposerText('');
      });
      return;
    }
    const shouldJump = draft.trim().length > 0 || attachmentCount > 0;
    const sendResult = runtime.onSendChatMessage(
      draftOverride,
      undefined,
      undefined,
      attachmentOverride,
    );
    if (shouldJump) {
      scheduleTranscriptScrollToBottom(transcript.chatTranscriptScrollRef);
    }
    return sendResult;
  };

  return (
    <>
      <section
        className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-white/[0.025]"
        data-active-side={presentation.activeSide}
      >
        {!isEmptySelection ? <MainChatHeader
          conversation={activeConv}
          layout={{
            showSessionToggle: layout.showChatDetailRail,
            sessionsCollapsed: layout.collapseChatSessions,
            onToggleSessions: () => {
              layout.setIsSessionPanelCollapsed((collapsed) => !collapsed);
            },
            showDestinations: layout.showRightDetailRail,
            destination: models.destinations.value,
            onSelectDestination: models.destinations.select,
          }}
          metadata={{
            subtitle: models.header.subtitle,
            forkSourceSessionId: models.fork.sourceSessionId,
            forkSourceTitle: models.fork.sourceTitle ?? 'source session',
            onOpenForkSource: runtime.onSelectSession,
          }}
          rename={{
            ...models.header.rename,
            commit: () => {
              void models.header.rename.commit();
            },
          }}
          companion={{
            canOpen: companion.canOpen,
            isOpen: presentation.showCompanionPane,
            suggestedName: companion.suggestedName,
            onOpen: () => {
              void companion.open();
            },
          }}
          supportReport={supportReportSessionId
            && submitSupportReport
            ? {
                sessionId: supportReportSessionId,
                onSubmit: submitSupportReport,
              }
            : undefined}
        /> : null}

        {models.destinations.value === 'messages' ? (
          <div
            id="chat-main-messages-panel"
            className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
            role="tabpanel"
            aria-labelledby="chat-main-messages-tab"
            data-chat-destination-page="messages"
            data-chat-destination-scope="main"
          >
            <ConversationCallBanner conversation={activeConv} />
            {needsProvider ? (
              <AuthNoticeBanner
                title="No provider connected yet"
                description={auth.onOpenAccountAuthentication
                  ? 'Connect a provider, save an API key, or choose a local LM Studio/Ollama server before starting AI chats.'
                  : 'Connect a cloud provider, save an API key, or choose a local LM Studio/Ollama server in Authentication before starting AI chats.'}
                actionLabel="Open authentication"
                onAction={openAuthentication}
              />
            ) : null}

            {models.pins.pinnedMessage ? (
              <PinnedMessageBar
                message={models.pins.pinnedMessage}
                onOpenMessage={models.pins.openPinnedMessage}
                onRequestUnpin={() => {
                  if (models.pins.pinnedMessage) {
                    models.pins.requestUnpin(models.pins.pinnedMessage);
                  }
                }}
              />
            ) : null}

            <SupportReportSubmissionProvider
              accountId={supportAccountId}
              sessionId={supportReportSessionId}
              onSubmit={submitSupportReport}
              onLookup={getSupportReport}
            >
              <ChatSessionPane
              presentation={{
                liveTurn: presentation.liveTurn,
                liveTurnSender,
                shouldRenderLiveTurn,
                densityMode: chatTranscriptDensityMode(activeConv),
                isCompressionActive: presentation.isCompressionActive,
                plainAgentResponse:
                  shouldSuppressAgentReplyAttribution(activeConv),
                inferLatestHumanReplyTarget:
                  shouldInferLatestHumanReplyTarget(activeConv),
                forkSnapshotBoundaryIndex: models.fork.snapshotBoundaryIndex,
                activeForkSourceSessionId: models.fork.sourceSessionId,
                activeForkSourceTitle: models.fork.sourceTitle,
                messageForksByEntryId: models.fork.forksByEntryId,
                pinnedMessageId: models.pins.pinnedMessageId,
              }}
              actions={{
                onSelectSession: runtime.onSelectSession,
                onOpenSource: transcript.onOpenSource,
                onOpenArtifact: transcript.onOpenArtifact,
                onOpenAuthSettings: openAuthentication,
                onNavigateToMessage: models.navigation.navigate,
                onOpenMessageDetail: composer.onSelectMessage,
                onStopCollaborationAgentRequest:
                  runtime.onStopCollaborationAgentRequest,
                onStopActiveTurn: runtime.onStopDesktopChatTurn,
                onRequestCollaborationContact:
                  runtime.onRequestCollaborationContact,
                onOpenSenderProfile: models.senderProfiles.openActive,
                onForkMessage: models.fork.forkMessage,
                onOpenForkSession: runtime.onSelectSession,
                onReplyMessage: composer.onReplyMessage,
                onForwardMessage: composer.onForwardMessage,
                onRetryMessage: runtime.onRetryChatMessage,
                onSelectMessage: composer.onSelectMessage,
                onRequestPinMessage: models.pins.requestPin,
                onRequestUnpinMessage: models.pins.requestUnpin,
              }}
              selection={{
                selectionMode: composer.messageSelectionMode,
                selectedMessageIds: composer.selectedMessageIds,
                isMessageSelectable: composer.isMessageSelectable,
                onToggleSelectedMessage: composer.onToggleSelectedMessage,
                onSelectionDragStart: composer.onSelectionDragStart,
                onSelectionDragEnter: composer.onSelectionDragEnter,
                onSelectionDragEnd: composer.onSelectionDragEnd,
                onCancelMessageSelection: composer.onCancelMessageSelection,
                onSelectAllMessages: composer.onSelectAllMessages,
              }}
              viewport={{
                sessionKey: activeConv.id,
                messages: presentation.messages,
                scrollRef: transcript.chatTranscriptScrollRef,
                scrollClassName:
                  'app-chat-pane-transcript-scroll min-h-0 flex-1 overflow-x-hidden overscroll-contain',
                hasOlderMessages: Boolean(
                  canonicalHistorySessionId
                    && transcript.canonicalHasOlderBySessionId?.[
                      canonicalHistorySessionId
                    ],
                ),
                onLoadOlderMessages:
                  canonicalHistorySessionId
                    && transcript.onLoadOlderCanonicalSessionMessages
                    ? () => transcript.onLoadOlderCanonicalSessionMessages?.(
                        canonicalHistorySessionId,
                      )
                    : undefined,
                emptyState: isEmptySelection
                  ? <ChatSelectionEmptyState />
                  : models.header.isStarting
                    ? <SessionStartingState />
                    : activeConv.supportTicketEnabled
                      ? <SupportConversationEmptyState />
                      : null,
                navigationRequest: models.navigation.request,
                onNavigationHandled: models.navigation.acknowledge,
                onTranscriptScroll: transcript.onTranscriptScroll,
                queuedMessages: transcript.queuedDesktopMessages,
                onEditQueuedMessage: transcript.onEditQueuedMessage,
                onCancelQueuedMessage: transcript.onCancelQueuedMessage,
                composer: isEmptySelection ? null : (
                  <ChatComposerShell
                    chatComposerAttachments={composer.chatComposerAttachments}
                    saveDesktopAttachments={composer.saveDesktopAttachments}
                    saveDesktopAttachmentPaths={
                      composer.saveDesktopAttachmentPaths
                    }
                    removeChatComposerAttachment={
                      composer.removeChatComposerAttachment
                    }
                    activeChatQuote={composer.activeChatQuote}
                    onForwardMessage={composer.onForwardMessage}
                    onOpenMessageDetail={composer.onSelectMessage}
                    rightDetailRail={layout.rightDetailRail}
                    setIsDetailPanelCollapsed={
                      layout.setIsDetailPanelCollapsed
                    }
                  >
                    <MainComposer
                      conversation={activeConv}
                      cloudAccountId={session.cloudAccount?.accountId}
                      composer={composer}
                      runtime={runtime}
                      localRouting={{
                        paneKind: activePaneKind,
                        configTarget: localConfigTargetSessionId,
                        contextStatus: runtime.activeRuntimeContextStatus,
                        cacheText: runtime.activeRuntimeCacheText,
                      }}
                      collaborationRouting={{
                        enabled: models.routing.enabled,
                        notice: models.routing.notice,
                        model: models.routing.selectedAgent ? {
                          agents: models.routing.agents,
                          selectedAgent: models.routing.selectedAgent,
                          selection: models.routing.selection,
                          visibility: models.routing.visibility,
                        } : null,
                        agentSelectorOpen: models.routing.selectorOpen,
                        onSelectAgent: (agentId) => {
                          models.routing.setSelectedAgentId(agentId);
                          runtime.toggleComposerSelector('chat', 'mode');
                        },
                        onUpdate: models.routing.update,
                        onSaveCompact: models.routing.saveCompactRoute,
                        defaultThinkingForModel:
                          models.routing.defaultThinkingForModel,
                      }}
                      display={{
                        isNativeShell: layout.isNativeShell,
                        showCompanionPane:
                          presentation.showCompanionPane,
                        activeLiveTurnIsRunning:
                          presentation.activeLiveTurnIsRunning,
                        prefersReducedMotion:
                          presentation.prefersReducedMotion,
                        placeholder: chatComposerPlaceholder(activeConv),
                      }}
                      onSend={handleSend}
                    />
                  </ChatComposerShell>
                ),
              }}
              />
            </SupportReportSubmissionProvider>
          </div>
        ) : (
          <div
            id={`chat-main-${models.destinations.value}-panel`}
            className="min-h-0 min-w-0 flex-1 overflow-hidden"
            role="tabpanel"
            aria-labelledby={`chat-main-${models.destinations.value}-tab`}
            data-chat-destination-page={models.destinations.value}
            data-chat-destination-scope="main"
          >
            {layout.rightDetailRail}
          </div>
        )}
      </section>

      {models.senderProfiles.target ? (
        <MemberContactProfilePopover
          participant={models.senderProfiles.target.participant}
          contacts={models.senderProfiles.contacts}
          presenceStatus={
            models.senderProfiles.target.participant.presenceStatus
          }
          anchorRect={models.senderProfiles.target.anchorRect}
          onAddContact={models.senderProfiles.sendRequest}
          onMessageContact={models.senderProfiles.messageContact}
          onClose={models.senderProfiles.close}
        />
      ) : null}
      {models.pins.dialog.value ? (
        <PinMessageDialog
          mode={models.pins.dialog.value.mode}
          message={models.pins.dialog.value.message}
          pinForEveryone={models.pins.dialog.pinForEveryone}
          onTogglePinForEveryone={models.pins.dialog.setPinForEveryone}
          onCancel={models.pins.dialog.cancel}
          onConfirm={models.pins.dialog.confirm}
        />
      ) : null}
    </>
  );
}
