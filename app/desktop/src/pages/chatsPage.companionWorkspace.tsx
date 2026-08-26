import { useEffect, useRef, useState } from 'react';
import { GripVertical, RefreshCw } from 'lucide-react';

import { localOwnedAgentSenderLabel } from '@/app/viewModels/helpers';
import {
  composerAttachmentItemFromFile,
  composerAttachmentItemFromStoredPath,
  composerAttachmentKindFromName,
  composerAttachmentNameFromPath,
  friendlyAttachmentName,
  updatedComposerAttachment,
} from '@/features/chat/composerAttachments';
import type {
  AttachmentItemUpdate,
  SaveDesktopAttachmentOptions,
} from '@/features/chat/composerController.types';
import { shouldInferLatestHumanReplyTarget, shouldSuppressAgentReplyAttribution } from '@/features/chat/replyAttribution';
import { transcriptLoadingNotice } from '@/features/chat/transcriptLoadingNotice';
import { useCompanionComposerRuntime } from '@/features/chat/useCompanionComposerRuntime';
import type {
  DesktopChatTurnSnapshot,
  Message,
} from '@/kordi-app/types';
import { pickDesktopChatAttachmentPaths } from '@/lib/cloudAttachmentUpload';
import { storeDesktopChatAttachmentPath } from '@/lib/desktop';
import { CompanionComposer } from '@/pages/chatsPage.companionComposer';
import { CompanionDestinationPage } from '@/pages/chatsPage.companionDestination';
import { CompanionHeader } from '@/pages/chatsPage.companionHeader';
import { CompanionPane } from '@/pages/chatsPage.companionPane';
import {
  canonicalHistorySessionIdForConversation,
  chatTranscriptDensityMode,
  conversationPaneKind,
} from '@/pages/chatsPage.model';
import { localAgentComposerConfigTargetSessionId } from '@/pages/chatsPage.header';
import type {
  ChatAttachment,
  ChatsPageComposer,
  ChatsPageLayout,
  ChatsPageRuntime,
  ChatsPageTranscript,
  ChatSessionPanePresentation,
} from '@/pages/chatsPage.types';
import type { useChatCollaborationRouting } from '@/pages/useChatCollaborationRouting';
import type { useChatCompanionLayout } from '@/pages/useChatCompanionLayout';
import type { useChatCompanionSession } from '@/pages/useChatCompanionSession';
import type { useChatDestinations } from '@/pages/useChatDestinations';
import type { useChatSenderProfiles } from '@/pages/useChatSenderProfiles';
import type { useChatTranscriptNavigation } from '@/pages/useChatTranscriptNavigation';

type ChatCompanionWorkspaceProps = {
  session: ReturnType<typeof useChatCompanionSession>;
  layoutModel: ReturnType<typeof useChatCompanionLayout>;
  destinations: ReturnType<typeof useChatDestinations>['companion'];
  routing: ReturnType<typeof useChatCollaborationRouting>['companion'];
  navigation: ReturnType<typeof useChatTranscriptNavigation>['companion'];
  senderProfiles: ReturnType<typeof useChatSenderProfiles>;
  presentation: {
    messages: readonly Message[];
    liveTurn?: DesktopChatTurnSnapshot | null;
    isCollaborationAgent: boolean;
    showsLocalAgentControls: boolean;
    prefersReducedMotion: boolean | null;
    relatedAgentSessionStatusById?: ChatSessionPanePresentation['relatedAgentSessionStatusById'];
  };
  shell: {
    isNativeShell: boolean;
    openAuthentication: () => void;
    onCreateSession: () => void;
  };
  layout: Pick<
    ChatsPageLayout,
    'rightDetailRail' | 'setIsDetailPanelCollapsed'
  >;
  transcript: Pick<
    ChatsPageTranscript,
    | 'canonicalHasOlderBySessionId'
    | 'onLoadOlderCanonicalSessionMessages'
    | 'queuedDesktopMessagesBySession'
    | 'onEditQueuedMessage'
    | 'onCancelQueuedMessage'
  >;
  composer: ChatsPageComposer;
  runtime: ChatsPageRuntime;
};

export function ChatCompanionWorkspace({
  session,
  layoutModel,
  destinations,
  routing,
  navigation,
  senderProfiles,
  presentation,
  shell,
  layout,
  transcript,
  composer,
  runtime,
}: ChatCompanionWorkspaceProps) {
  const conversation = session.conversation;
  const [companionAttachments, setCompanionAttachments] = useState<ChatAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const companionAttachmentsRef = useRef<ChatAttachment[]>([]);
  useEffect(() => () => {
    companionAttachmentsRef.current.forEach((attachment) => {
      if (attachment.previewUrl?.startsWith('blob:')) {
        URL.revokeObjectURL(attachment.previewUrl);
      }
    });
  }, []);
  const paneKind = conversation ? conversationPaneKind(conversation) : null;
  const localConfigTargetSessionId = conversation
    ? localAgentComposerConfigTargetSessionId(conversation)
    : null;
  const localRuntime = useCompanionComposerRuntime({
    enabled: presentation.showsLocalAgentControls,
    isNativeShell: shell.isNativeShell,
    sessionId: localConfigTargetSessionId,
    fallbackMode: runtime.composerSelection.mode,
    modelOptions: runtime.chatModelOptions ?? [],
    authOptions: runtime.composerAuthOptions,
  });
  if (!conversation) return null;

  const updateCompanionAttachments = (
    update: (current: ChatAttachment[]) => ChatAttachment[],
  ) => {
    setCompanionAttachments((current) => {
      const next = update(current);
      companionAttachmentsRef.current = next;
      return next;
    });
  };
  const appendAttachments = (saved: ChatAttachment[]) => {
    updateCompanionAttachments((current) => {
      const seen = new Set(current.map((attachment) => attachment.path));
      return [...current, ...saved.filter((attachment) => !seen.has(attachment.path))];
    });
  };
  const saveAttachments = async (
    files: File[],
    options: SaveDesktopAttachmentOptions = {},
  ) => {
    if (!shell.isNativeShell || files.length === 0) return [];
    try {
      setAttachmentError(null);
      const saved = await Promise.all(
        files.map((file) => composerAttachmentItemFromFile(file, options)),
      );
      appendAttachments(saved);
      return saved;
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : 'Unable to attach file');
      return [];
    }
  };
  const saveAttachmentPaths = async (paths?: string[]) => {
    if (!shell.isNativeShell) return [];
    try {
      setAttachmentError(null);
      const selectedPaths = paths ?? await pickDesktopChatAttachmentPaths();
      if (selectedPaths.length === 0) return [];
      const saved = await Promise.all(selectedPaths.map(async (sourcePath) => {
        const rawName = composerAttachmentNameFromPath(sourcePath);
        const kind = composerAttachmentKindFromName(rawName);
        const displayName = friendlyAttachmentName(rawName, kind);
        const stored = await storeDesktopChatAttachmentPath(sourcePath, displayName);
        return composerAttachmentItemFromStoredPath({ sourcePath, stored, displayName });
      }));
      appendAttachments(saved);
      return saved;
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : 'Unable to attach file');
      return [];
    }
  };
  const removeAttachment = (id: string) => {
    updateCompanionAttachments((current) => {
      const removed = current.find((attachment) => attachment.id === id);
      if (removed?.previewUrl?.startsWith('blob:')) {
        URL.revokeObjectURL(removed.previewUrl);
      }
      return current.filter((attachment) => attachment.id !== id);
    });
  };
  const updateAttachment = (id: string, update: AttachmentItemUpdate) => {
    updateCompanionAttachments((current) => current.map((attachment) => (
      attachment.id === id ? updatedComposerAttachment(attachment, update) : attachment
    )));
  };
  const companionComposer: ChatsPageComposer = {
    ...composer,
    chatComposerAttachments: companionAttachments,
    saveDesktopAttachments: saveAttachments,
    saveDesktopAttachmentPaths: saveAttachmentPaths,
    removeChatComposerAttachment: removeAttachment,
    updateChatComposerAttachment: updateAttachment,
  };

  const canonicalHistorySessionId =
    canonicalHistorySessionIdForConversation(conversation);
  const transcriptMessages = session.transcript.isLoading
    ? [transcriptLoadingNotice()]
    : session.transcript.loadError
      ? []
      : presentation.messages;
  const destinationPage = destinations.value !== 'messages' ? (
    <CompanionDestinationPage
      conversation={conversation}
      destination={destinations.activeDetailTab}
      isNativeShell={shell.isNativeShell}
      liveTurn={presentation.liveTurn}
      activeArtifactId={destinations.activeArtifactId}
      activeSourcePreview={destinations.activeSourcePreview}
      actions={{
        setDestination: destinations.setValue,
        setActiveArtifactId: destinations.setActiveArtifactId,
        setActiveSourcePreview: destinations.setActiveSourcePreview,
        onNavigateToResponse: navigation.navigate,
        onOpenOutreachThread: runtime.onSelectSession,
      }}
    />
  ) : null;

  return (
    <CompanionPane
      conversation={conversation}
      side={layoutModel.side}
      destination={destinations.value}
      header={(
        <CompanionHeader
          conversation={conversation}
          sessionOptions={session.sessionOptions}
          side={layoutModel.side}
          destination={destinations.value}
          menu={{
            actionsOpen: session.menu.actionsOpen,
            sessionListOpen: session.menu.sessionListOpen,
            canCreateSession: session.menu.canCreateSession,
          }}
          actions={{
            onDragStart: layoutModel.onDragStart,
            onDragEnd: layoutModel.onDragEnd,
            onToggleActions: session.menu.toggleActions,
            onCloseActions: session.menu.closeActions,
            onCloseSessionList: session.menu.closeSessionList,
            onOpenSessionList: session.menu.openSessionList,
            onSwitchConversation: session.actions.switchConversation,
            onCreateSession: shell.onCreateSession,
            onClose: session.actions.close,
            onSelectDestination: (destination) => {
              destinations.setActiveSourcePreview(null);
              destinations.setValue(destination);
            },
          }}
        />
      )}
      detailPage={destinationPage}
      messagesLoading={session.transcript.isLoading}
      sessionPane={{
        presentation: {
          liveTurn: presentation.liveTurn,
          liveTurnSender: localOwnedAgentSenderLabel(conversation),
          shouldRenderLiveTurn: Boolean(
            !session.transcript.isLoading
              && presentation.liveTurn
              && !presentation.liveTurn.completed,
          ),
          densityMode: chatTranscriptDensityMode(conversation),
          inferLatestHumanReplyTarget:
            shouldInferLatestHumanReplyTarget(conversation),
          plainAgentResponse: shouldSuppressAgentReplyAttribution(conversation),
          relatedAgentSessionStatusById: presentation.relatedAgentSessionStatusById,
        },
        actions: {
          onOpenSource: (file) => {
            destinations.setActiveSourcePreview(file);
            destinations.setValue('artifacts');
          },
          onOpenArtifact: (artifactId) => {
            destinations.setActiveSourcePreview(null);
            destinations.setActiveArtifactId(artifactId);
            destinations.setValue('artifacts');
          },
          onOpenAuthSettings: shell.openAuthentication,
          onNavigateToMessage: navigation.navigate,
          onOpenMessageDetail: composer.onSelectMessage,
          onStopCollaborationAgentRequest:
            runtime.onStopCollaborationAgentRequest,
          onStopActiveTurn: runtime.onStopDesktopChatTurn,
          onRequestCollaborationContact:
            runtime.onRequestCollaborationContact,
          onOpenSenderProfile: senderProfiles.openCompanion,
          onForkMessage: runtime.onForkChatMessage
            ? (entryId) => {
                void runtime.onForkChatMessage?.(conversation.id, entryId);
              }
            : undefined,
          onOpenForkSession: session.actions.switchConversation,
          onForwardMessage: composer.onForwardMessage,
          onReactMessage: composer.onReactMessage,
          onSelectMessage: composer.onSelectMessage,
        },
        selection: {},
        viewport: {
          sessionKey: conversation.id,
          messages: transcriptMessages,
          scrollRef: session.refs.transcriptScroll,
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
          navigationRequest: navigation.request,
          onNavigationHandled: navigation.acknowledge,
          queuedMessages:
            transcript.queuedDesktopMessagesBySession[conversation.id] ?? [],
          onEditQueuedMessage: transcript.onEditQueuedMessage,
          onCancelQueuedMessage: transcript.onCancelQueuedMessage,
          emptyState: (
            session.transcript.loadError ? (
              <div
                className="flex h-full min-h-[12rem] flex-col items-center justify-center gap-2 px-4 text-center text-[12px] text-[color:var(--utility-muted-text)]"
                role="alert"
              >
                <span>{session.transcript.loadError}</span>
                <button
                  type="button"
                  className="app-button-quiet inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium"
                  onClick={session.transcript.retry}
                >
                  <RefreshCw className="h-3 w-3" aria-hidden="true" />
                  Try again
                </button>
              </div>
            ) : (
              <div className="flex h-full min-h-[12rem] items-center justify-center px-4 text-center text-[12px] text-slate-500">
                No messages in this side chat yet.
              </div>
            )
          ),
        },
      }}
      composerShell={{
        className: 'pt-3',
        chatComposerAttachments: companionAttachments,
        saveDesktopAttachments: saveAttachments,
        saveDesktopAttachmentPaths: saveAttachmentPaths,
        removeChatComposerAttachment: removeAttachment,
        activeChatQuote: composer.activeChatQuote,
        onForwardMessage: composer.onForwardMessage,
        rightDetailRail: layout.rightDetailRail,
        setIsDetailPanelCollapsed: layout.setIsDetailPanelCollapsed,
      }}
      composer={(
        <CompanionComposer
          conversation={conversation}
          paneKind={paneKind ?? 'agent'}
          draftText={session.draftText}
          attachmentError={attachmentError}
          isNativeShell={shell.isNativeShell}
          attachmentInputRef={session.refs.attachmentInput}
          composer={companionComposer}
          runtime={runtime}
          localRouting={{
            enabled: presentation.showsLocalAgentControls,
            selection: localRuntime.selection,
            configTarget: localRuntime.configTarget,
            authLabel: localRuntime.authLabel,
            authOptions: localRuntime.authOptions,
            isLoading: localRuntime.isLoading,
            loadError: localRuntime.loadError,
            retry: localRuntime.retry,
            runtimeContextStatus: conversation.contextWindowStatus ?? null,
            runtimeCacheText: conversation.cacheMonitorText ?? null,
          }}
          collaborationRouting={{
            enabled: presentation.isCollaborationAgent,
            notice: routing.notice,
            agents: routing.agents,
            selectedAgent: routing.selectedAgent,
            selection: routing.selection,
            visibility: routing.visibility,
            selectorOpen: routing.selectorOpen,
            setSelectedAgentId: routing.setSelectedAgentId,
            update: routing.update,
            defaultThinkingForModel: routing.defaultThinkingForModel,
          }}
          ui={{
            openSelector: session.selector.value,
            setOpenSelector: session.selector.set,
            toggleSelector: session.selector.toggle,
            prefersReducedMotion: presentation.prefersReducedMotion,
          }}
          onDraftChange={session.actions.updateDraft}
          onSend={(targetConversation) => {
            if (!session.actions.sendDraft(targetConversation, companionAttachments)) return;
            updateCompanionAttachments(() => []);
            setAttachmentError(null);
          }}
        />
      )}
    />
  );
}

export function ChatCompanionSplitDivider({
  layoutModel,
}: {
  layoutModel: ReturnType<typeof useChatCompanionLayout>;
}) {
  if (!layoutModel.isVisible) return null;
  return (
    <div
      className="app-chat-split-divider group relative z-10 flex h-full w-2.5 cursor-col-resize touch-none items-center justify-center bg-transparent transition hover:bg-white/[0.035]"
      data-split-layout-divider="true"
      onPointerDown={layoutModel.onDividerPointerDown}
      onPointerMove={layoutModel.onDividerPointerMove}
      onPointerUp={layoutModel.onDividerPointerUp}
      onPointerCancel={layoutModel.onDividerPointerUp}
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
  );
}
