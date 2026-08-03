import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { Split } from 'lucide-react';

import { highlightTranscriptMessage } from '@/features/chat/transcriptNavigation';
import { transcriptMessageRenderKey } from '@/features/chat/transcriptRenderKeys';
import { transcriptWindowMessageMatchesId } from '@/features/chat/transcriptWindowing';
import { VirtualTranscript } from '@/features/chat/VirtualTranscript';
import { MessageBubble } from '@/kordi-app/components';
import type { Message } from '@/kordi-app/types';
import type { ChatSessionPaneProps } from '@/pages/chatsPage.types';
import { QueuedMessageBubble } from '@/pages/chatsPage.queuedMessage';

type TranscriptEntry = {
  message: Message;
  originalIndex: number;
};

function humanTranscriptGroupKey(message?: Message) {
  if (
    !message
    || message.role === 'system'
    || message.role === 'action'
    || message.role === 'edit'
    || message.turn
  ) return null;
  const senderType = message.senderType
    ?? (message.role === 'user' || message.role === 'person' ? 'human' : 'agent');
  const isOwnHuman = (message.isOwnMessage ?? message.role === 'user') && senderType === 'human';
  const isPeerHuman = !isOwnHuman && (senderType === 'human' || message.role === 'person');
  if (!isOwnHuman && !isPeerHuman) return null;
  const side = isOwnHuman ? 'own' : 'peer';
  const senderKey = message.senderAvatarSeed?.trim()
    || message.senderProfileImageUrl?.trim()
    || message.sender?.trim()
    || side;
  return `${side}:${senderKey}`;
}

function isGroupedWithAdjacentHumanMessage(
  messages: readonly Message[],
  index: number,
  offset: -1 | 1,
) {
  const currentKey = humanTranscriptGroupKey(messages[index]);
  return Boolean(currentKey && currentKey === humanTranscriptGroupKey(messages[index + offset]));
}

export function useChatTranscriptViewport({
  viewport,
  presentation,
  actions,
  selection,
  transcriptEntries,
  transcriptMessages,
  transcriptTailKey,
}: ChatSessionPaneProps & {
  transcriptEntries: TranscriptEntry[];
  transcriptMessages: Message[];
  transcriptTailKey: string;
}) {
  const {
    sessionKey,
    scrollRef,
    scrollClassName,
    onTranscriptScroll,
    hasOlderMessages = false,
    onLoadOlderMessages,
    navigationRequest,
    onNavigationHandled,
    emptyState,
    queuedMessages = [],
    onEditQueuedMessage,
    onCancelQueuedMessage,
  } = viewport;
  const {
    isCompressionActive = false,
    plainAgentResponse = false,
    forkSnapshotBoundaryIndex = -1,
    activeForkSourceSessionId = null,
    activeForkSourceTitle = null,
    messageForksByEntryId,
    pinnedMessageId,
    densityMode = 'default',
  } = presentation;
  const {
    onSelectSession,
    onOpenSource,
    onOpenArtifact,
    onOpenAuthSettings,
    onNavigateToMessage,
    onOpenMessageDetail,
    onStopCollaborationAgentRequest,
    onStopActiveTurn,
    onRequestCollaborationContact,
    onOpenSenderProfile,
    onForkMessage,
    onOpenForkSession,
    onReplyMessage,
    onForwardMessage,
    onRetryMessage,
    onSelectMessage,
    onRequestPinMessage,
    onRequestUnpinMessage,
  } = actions;
  const {
    selectionMode = false,
    selectedMessageIds,
    isMessageSelectable,
    onToggleSelectedMessage,
    onSelectionDragStart,
    onSelectionDragEnter,
    onSelectionDragEnd,
  } = selection;

  const handleNavigationReady = useCallback(
    (messageId: string) => highlightTranscriptMessage(messageId),
    [],
  );
  const loadOlderMessagesRef = useRef(onLoadOlderMessages);
  useLayoutEffect(() => {
    loadOlderMessagesRef.current = onLoadOlderMessages;
  }, [onLoadOlderMessages]);
  const handleLoadOlderMessages = useCallback(() => loadOlderMessagesRef.current?.(), []);
  const canLoadOlderMessages = Boolean(onLoadOlderMessages);

  return useMemo(() => (
    <VirtualTranscript
      items={transcriptEntries}
      sessionKey={sessionKey}
      scrollRef={scrollRef}
      scrollClassName={scrollClassName}
      onScroll={() => onTranscriptScroll?.()}
      navigationRequest={navigationRequest}
      onNavigationHandled={onNavigationHandled}
      findNavigationIndex={(entry, messageId) => transcriptWindowMessageMatchesId(
        entry.message,
        messageId,
        entry.originalIndex,
      )}
      onNavigationReady={handleNavigationReady}
      hasOlder={hasOlderMessages}
      onLoadOlder={canLoadOlderMessages ? handleLoadOlderMessages : undefined}
      getItemKey={(entry) => transcriptMessageRenderKey(entry.message, entry.originalIndex)}
      renderItem={({ message: msg, originalIndex: idx }) => (
        <div>
          <MessageBubble
            msg={msg}
            onOpenSource={onOpenSource}
            onOpenArtifact={onOpenArtifact}
            onOpenAuthSettings={onOpenAuthSettings}
            onNavigateToMessage={onNavigateToMessage}
            onStopCollaborationAgentRequest={onStopCollaborationAgentRequest}
            onStopActiveTurn={onStopActiveTurn}
            onRequestCollaborationContact={onRequestCollaborationContact}
            onOpenSenderProfile={onOpenSenderProfile}
            onForkMessage={onForkMessage}
            messageForks={msg.entryId ? messageForksByEntryId?.get(msg.entryId) : undefined}
            onOpenForkSession={onOpenForkSession}
            onReplyMessage={onReplyMessage}
            onForwardMessage={onForwardMessage}
            onRetryMessage={onRetryMessage}
            onOpenMessageDetail={onOpenMessageDetail}
            onSelectMessage={onSelectMessage}
            onRequestPinMessage={onRequestPinMessage}
            onRequestUnpinMessage={onRequestUnpinMessage}
            pinnedMessageId={pinnedMessageId}
            selectionMode={selectionMode}
            selectedMessageIds={selectedMessageIds}
            isMessageSelectable={isMessageSelectable}
            densityMode={densityMode}
            onToggleSelectedMessage={onToggleSelectedMessage}
            onSelectionDragStart={onSelectionDragStart}
            onSelectionDragEnter={onSelectionDragEnter}
            onSelectionDragEnd={onSelectionDragEnd}
            plainAgentResponse={plainAgentResponse}
            isGroupedWithPrevious={isGroupedWithAdjacentHumanMessage(transcriptMessages, idx, -1)}
            isGroupedWithNext={isGroupedWithAdjacentHumanMessage(transcriptMessages, idx, 1)}
          />
          {idx === forkSnapshotBoundaryIndex && activeForkSourceSessionId ? (
            <div className="my-2 flex items-center gap-3 px-2 text-[11px] font-medium uppercase tracking-[0.06em] text-sky-300">
              <span className="h-px flex-1 bg-sky-500/30" aria-hidden="true" />
              <button
                type="button"
                onClick={() => onSelectSession?.(activeForkSourceSessionId)}
                disabled={!onSelectSession}
                className="app-button-quiet inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-sky-300"
                title={`Open the source conversation${activeForkSourceTitle ? ` (${activeForkSourceTitle})` : ''}`}
              >
                <Split className="h-3 w-3" />
                <span>Forked from conversation</span>
              </button>
              <span className="h-px flex-1 bg-sky-500/30" aria-hidden="true" />
            </div>
          ) : null}
        </div>
      )}
      emptyState={transcriptMessages.length === 0 ? emptyState : null}
      tailKey={transcriptTailKey}
      tail={(
        <div className="space-y-1">
          {queuedMessages.map((message) => (
            <QueuedMessageBubble
              key={message.id}
              message={message}
              isCompressionActive={isCompressionActive}
              onEdit={onEditQueuedMessage}
              onCancel={onCancelQueuedMessage}
            />
          ))}
        </div>
      )}
    />
  ), [
    activeForkSourceSessionId,
    activeForkSourceTitle,
    canLoadOlderMessages,
    densityMode,
    emptyState,
    forkSnapshotBoundaryIndex,
    handleLoadOlderMessages,
    handleNavigationReady,
    hasOlderMessages,
    isCompressionActive,
    isMessageSelectable,
    messageForksByEntryId,
    navigationRequest,
    onCancelQueuedMessage,
    onEditQueuedMessage,
    onForwardMessage,
    onForkMessage,
    onNavigateToMessage,
    onNavigationHandled,
    onOpenArtifact,
    onOpenAuthSettings,
    onOpenForkSession,
    onOpenMessageDetail,
    onOpenSenderProfile,
    onOpenSource,
    onReplyMessage,
    onRequestCollaborationContact,
    onRequestPinMessage,
    onRequestUnpinMessage,
    onRetryMessage,
    onSelectMessage,
    onSelectSession,
    onSelectionDragEnd,
    onSelectionDragEnter,
    onSelectionDragStart,
    onStopActiveTurn,
    onStopCollaborationAgentRequest,
    onToggleSelectedMessage,
    onTranscriptScroll,
    pinnedMessageId,
    plainAgentResponse,
    queuedMessages,
    scrollClassName,
    scrollRef,
    selectedMessageIds,
    selectionMode,
    sessionKey,
    transcriptEntries,
    transcriptMessages,
    transcriptTailKey,
  ]);
}
