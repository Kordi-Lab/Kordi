import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { Split } from 'lucide-react';

import { shouldAnimateHumanMessageEntry } from '@/features/chat/deliveryStatus';
import { transcriptMessageRenderKey } from '@/features/chat/transcriptRenderKeys';
import { collectConversationImageAttachments } from '@/features/chat/attachmentMediaGallery';
import { transcriptTimeSeparatorLabels } from '@/features/chat/transcriptTimestamps';
import { transcriptWindowMessageMatchesId } from '@/features/chat/transcriptWindowing';
import { VirtualTranscript } from '@/features/chat/VirtualTranscript';
import { MessageBubble } from '@/kordi-app/components';
import { transcriptMessageIsOwnHuman } from '@/kordi-app/components/transcriptMessageHumanRole';
import type { Message } from '@/kordi-app/types';
import type { ChatSessionPaneProps } from '@/pages/chatsPage.types';
import { QueuedMessageBubble } from '@/pages/chatsPage.queuedMessage';
import { PinActivityNotice } from '@/pages/chatsPage.pins';

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

export function isGroupedWithAdjacentHumanMessage(
  messages: readonly Message[],
  index: number,
  offset: -1 | 1,
  timeSeparators: readonly (string | null)[] = [],
) {
  if (offset === -1 && timeSeparators[index]) return false;
  if (offset === 1 && timeSeparators[index + 1]) return false;
  const currentKey = humanTranscriptGroupKey(messages[index]);
  return Boolean(currentKey && currentKey === humanTranscriptGroupKey(messages[index + offset]));
}

function transcriptTimestampDateTime(timestampMs?: number | null) {
  if (typeof timestampMs !== 'number' || !Number.isFinite(timestampMs)) return undefined;
  const date = new Date(timestampMs);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
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
    pinnedMessageIds,
    pinActivityLabel,
    densityMode = 'default',
    relatedAgentSessionStatusById,
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
    onReactMessage,
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
    onCancelMessageSelection,
    onSelectAllMessages,
  } = selection;

  const loadOlderMessagesRef = useRef(onLoadOlderMessages);
  useLayoutEffect(() => {
    loadOlderMessagesRef.current = onLoadOlderMessages;
  }, [onLoadOlderMessages]);
  const handleLoadOlderMessages = useCallback(() => loadOlderMessagesRef.current?.(), []);
  const canLoadOlderMessages = Boolean(onLoadOlderMessages);
  const timeSeparators = useMemo(
    () => transcriptTimeSeparatorLabels(transcriptMessages),
    [transcriptMessages],
  );
  const imageGallery = useMemo(
    () => collectConversationImageAttachments(transcriptMessages),
    [transcriptMessages],
  );
  const latestMessage = transcriptMessages[transcriptMessages.length - 1];
  const animateLatestAppend = Boolean(
    latestMessage
    && shouldAnimateHumanMessageEntry(
      transcriptMessageIsOwnHuman(latestMessage),
      latestMessage.statusChips?.[0]?.trim().toLowerCase(),
    ),
  );

  return useMemo(() => (
    <VirtualTranscript
      items={transcriptEntries}
      sessionKey={sessionKey}
      scrollRef={scrollRef}
      scrollClassName={['app-chat-canvas', scrollClassName].join(' ')}
      onScroll={() => onTranscriptScroll?.()}
      navigationRequest={navigationRequest}
      onNavigationHandled={onNavigationHandled}
      findNavigationIndex={(entry, messageId) => transcriptWindowMessageMatchesId(
        entry.message,
        messageId,
        entry.originalIndex,
      )}
      hasOlder={hasOlderMessages}
      onLoadOlder={canLoadOlderMessages ? handleLoadOlderMessages : undefined}
      selectionMode={selectionMode}
      onCancelMessageSelection={onCancelMessageSelection}
      onSelectAllMessages={onSelectAllMessages}
      animateLatestAppend={animateLatestAppend}
      getItemKey={(entry) => transcriptMessageRenderKey(entry.message, entry.originalIndex)}
      renderItem={({ message: msg, originalIndex: idx }) => (
        <div>
          {timeSeparators[idx] ? (
            <div
              className="app-transcript-time-separator flex justify-center px-2 py-2 text-center text-[11px] font-normal leading-4 tabular-nums text-[color:var(--utility-muted-text)]"
              data-transcript-time-separator="true"
            >
              <time dateTime={transcriptTimestampDateTime(msg.timestampMs)}>{timeSeparators[idx]}</time>
            </div>
          ) : null}
          <MessageBubble
            msg={msg}
            imageGallery={imageGallery}
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
            relatedAgentSessionStatusById={relatedAgentSessionStatusById}
            onReplyMessage={onReplyMessage}
            onForwardMessage={onForwardMessage}
            onReactMessage={onReactMessage}
            onRetryMessage={onRetryMessage}
            onOpenMessageDetail={onOpenMessageDetail}
            onSelectMessage={onSelectMessage}
            onRequestPinMessage={onRequestPinMessage}
            onRequestUnpinMessage={onRequestUnpinMessage}
            pinnedMessageIds={pinnedMessageIds}
            selectionMode={selectionMode}
            selectedMessageIds={selectedMessageIds}
            isMessageSelectable={isMessageSelectable}
            densityMode={densityMode}
            onToggleSelectedMessage={onToggleSelectedMessage}
            onSelectionDragStart={onSelectionDragStart}
            onSelectionDragEnter={onSelectionDragEnter}
            onSelectionDragEnd={onSelectionDragEnd}
            plainAgentResponse={plainAgentResponse}
            isGroupedWithPrevious={isGroupedWithAdjacentHumanMessage(transcriptMessages, idx, -1, timeSeparators)}
            isGroupedWithNext={isGroupedWithAdjacentHumanMessage(transcriptMessages, idx, 1, timeSeparators)}
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
      tailKey={`${transcriptTailKey}:${pinActivityLabel ?? ''}`}
      tail={(
        <div className="space-y-1">
          {pinActivityLabel ? <PinActivityNotice label={pinActivityLabel} /> : null}
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
    animateLatestAppend,
    canLoadOlderMessages,
    densityMode,
    emptyState,
    forkSnapshotBoundaryIndex,
    handleLoadOlderMessages,
    hasOlderMessages,
    isCompressionActive,
    imageGallery,
    isMessageSelectable,
    messageForksByEntryId,
    navigationRequest,
    onCancelQueuedMessage,
    onCancelMessageSelection,
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
    onReactMessage,
    onRequestCollaborationContact,
    onRequestPinMessage,
    onRequestUnpinMessage,
    onRetryMessage,
    onSelectMessage,
    onSelectAllMessages,
    onSelectSession,
    onSelectionDragEnd,
    onSelectionDragEnter,
    onSelectionDragStart,
    onStopActiveTurn,
    onStopCollaborationAgentRequest,
    onToggleSelectedMessage,
    onTranscriptScroll,
    pinnedMessageIds,
    plainAgentResponse,
    pinActivityLabel,
    queuedMessages,
    relatedAgentSessionStatusById,
    scrollClassName,
    scrollRef,
    selectedMessageIds,
    selectionMode,
    sessionKey,
    transcriptEntries,
    transcriptMessages,
    timeSeparators,
    transcriptTailKey,
  ]);
}
