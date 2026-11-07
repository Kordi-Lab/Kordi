import type { ComponentProps } from 'react';

import { localOwnedAgentSenderLabel } from '@/app/viewModels/helpers';
import { threadRootSource, type MessageThread } from '@/features/chat/messageThreads';
import type { useThreadReadStatus } from '@/features/cloud/useThreadReadStatus';
import type { Conversation, DesktopChatTurnSnapshot, QueuedDesktopChatMessage } from '@/kordi-app/types';
import { ChatThreadPanel } from '@/pages/ChatThreadPanel';
import type { ChatsPageComposer, ChatsPageRuntime, ChatsPageTranscript } from '@/pages/chatsPage.types';
import type { useChatCollaborationRouting } from '@/pages/useChatCollaborationRouting';
import type { useChatPins } from '@/pages/useChatPins';
import type { useChatThreadSelection } from '@/pages/useChatThreadSelection';
import type { useUnreadThreadNavigation } from '@/pages/useUnreadThreadNavigation';

type ThreadPanelActions = ComponentProps<typeof ChatThreadPanel>['actions'];

export type ChatDiscussionPaneInput = {
  activeConv: Conversation;
  activeSessionId: string;
  activeThread: MessageThread | null;
  activeThreadRootId: string | null;
  activeLiveTurnThreadRootId: string | null;
  locatedLiveTurn?: DesktopChatTurnSnapshot | null;
  activeThreadQueuedMessages: QueuedDesktopChatMessage[];
  activePaneKind: 'human' | 'agent' | null;
  unreadThreads: ReturnType<typeof useUnreadThreadNavigation>;
  setOpenThreadState: ReturnType<typeof useChatThreadSelection>['setOpenThreadState'];
  threadReadStatus: ReturnType<typeof useThreadReadStatus>;
  routing: ReturnType<typeof useChatCollaborationRouting>['main'];
  pins: Pick<ReturnType<typeof useChatPins>, 'requestPin' | 'requestUnpin'>;
  runtime: ChatsPageRuntime;
  composer: ChatsPageComposer;
  transcript: ChatsPageTranscript;
  isNativeShell: boolean;
  accountId?: string;
  openAuthentication: ThreadPanelActions['onOpenAuthSettings'];
  navigateToMessage: ThreadPanelActions['onNavigateToMessage'];
  openSenderProfile: ThreadPanelActions['onOpenSenderProfile'];
  openRelatedAgentSession: ThreadPanelActions['onOpenForkSession'];
  handleReplyMessage: ThreadPanelActions['onReplyMessage'];
};

/** The open message discussion for the side panel's Discussion tab. */
export function chatDiscussionPane({
  activeConv, activeSessionId, activeThread, activeThreadRootId, activeLiveTurnThreadRootId, locatedLiveTurn,
  activeThreadQueuedMessages, activePaneKind, unreadThreads, setOpenThreadState, threadReadStatus, routing,
  pins, runtime, composer, transcript, isNativeShell, accountId, openAuthentication, navigateToMessage,
  openSenderProfile, openRelatedAgentSession, handleReplyMessage,
}: ChatDiscussionPaneInput) {
  if (!activeThread) return null;
  const loadedThreadPage = unreadThreads.page;
  const { composerSelection, composerProviderOptions, chatModelOptions } = runtime;
  return (
    <ChatThreadPanel
      conversation={activeConv}
      thread={activeThread}
      navigationMessageId={loadedThreadPage?.target}
      firstUnreadMessageId={loadedThreadPage?.first}
      nextAfterSequence={loadedThreadPage?.next}
      onLoadMore={() => void unreadThreads.load(activeThread.root.id, loadedThreadPage?.next ?? undefined)}
      liveTurn={activeLiveTurnThreadRootId === activeThreadRootId ? locatedLiveTurn : null}
      liveTurnSender={localOwnedAgentSenderLabel(activeConv)}
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
      accountId={accountId}
      readCursors={threadReadStatus.reads}
      onMarkRead={threadReadStatus.markRead}
      queuedMessages={activeThreadQueuedMessages}
      onCancelQueuedMessage={transcript.onCancelQueuedMessage}
      compactModelMenu={{
        selection: routing.enabled && routing.selectedAgent
          ? routing.selection ?? composerSelection
          : composerSelection,
        providerOptions: composerProviderOptions,
        modelOptions: chatModelOptions && chatModelOptions.length > 0
          ? chatModelOptions
          : undefined,
        onSave: routing.saveCompactRoute, sharedRoute: activePaneKind !== 'agent',
      }}
      chatMentionTargetsForText={composer.chatMentionTargetsForText}
      actions={{
        onOpenSource: transcript.onOpenSource,
        onOpenArtifact: transcript.onOpenArtifact,
        onOpenAuthSettings: openAuthentication,
        onNavigateToMessage: navigateToMessage,
        onOpenMessageDetail: composer.onSelectMessage,
        onStopCollaborationAgentRequest: runtime.onStopCollaborationAgentRequest,
        onStopActiveTurn: runtime.onStopDesktopChatTurn,
        onRequestCollaborationContact: runtime.onRequestCollaborationContact,
        onOpenSenderProfile: openSenderProfile,
        onOpenForkSession: openRelatedAgentSession,
        onReplyMessage: handleReplyMessage,
        onForwardMessage: composer.onForwardMessage,
        onEditMessage: composer.onEditMessage,
        onDeleteMessage: composer.onDeleteMessage,
        onReactMessage: composer.onReactMessage,
        onRetryMessage: runtime.onRetryChatMessage,
        onSelectMessage: composer.onSelectMessage,
        onRequestPinMessage: pins.requestPin,
        onRequestUnpinMessage: pins.requestUnpin,
      }}
    />
  );
}
