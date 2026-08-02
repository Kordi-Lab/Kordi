import { useCallback, useMemo } from 'react';
import type {
  Dispatch,
  ReactNode,
  SetStateAction,
} from 'react';
import {
  Copy,
  LoaderCircle,
  Send,
  Split,
} from 'lucide-react';

import { buildReplyAttribution } from '@/features/chat/replyAttribution';
import { buildDesktopLiveTurnTranscriptMessage } from '@/features/chat/desktopLiveTurns';
import { transcriptMessageRenderKey } from '@/features/chat/transcriptRenderKeys';
import {
  transcriptWindowMessageIdentity,
  transcriptWindowMessageMatchesId,
} from '@/features/chat/transcriptWindowing';
import { VirtualTranscript } from '@/features/chat/VirtualTranscript';
import {
  MessageBubble,
} from '@/kordi-app/components';
import {
  navigateToTranscriptMessage,
} from '@/kordi-app/components/transcriptReplyAttribution';
import type {
  ComposerQuoteState,
  Message,
} from '@/kordi-app/types';
import type {
  ChatAttachment as Attachment,
  ChatSessionPaneProps,
} from '@/pages/chatsPage.types';
import type { TranscriptNavigationRequest } from '@/pages/chatsPage.navigation';
import { QueuedMessageBubble } from '@/pages/chatsPage.queuedMessage';

function humanTranscriptGroupKey(message?: Message) {
  if (
    !message
    || message.role === 'system'
    || message.role === 'action'
    || message.role === 'edit'
    || message.turn
  ) {
    return null;
  }
  const senderType =
    message.senderType
    ?? (message.role === 'user' || message.role === 'person'
      ? 'human'
      : 'agent');
  const isOwnHuman =
    (message.isOwnMessage ?? message.role === 'user') && senderType === 'human';
  const isPeerHuman =
    !isOwnHuman && (senderType === 'human' || message.role === 'person');
  if (!isOwnHuman && !isPeerHuman) return null;

  const side = isOwnHuman ? 'own' : 'peer';
  const senderKey =
    message.senderAvatarSeed?.trim()
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
  return Boolean(
    currentKey && currentKey === humanTranscriptGroupKey(messages[index + offset]),
  );
}

export type ChatComposerShellProps = {
  children: ReactNode;
  chatComposerAttachments?: Attachment[];
  saveDesktopAttachments?: (files: File[]) => Promise<Attachment[]>;
  saveDesktopAttachmentPaths?: (paths: string[]) => Promise<Attachment[]>;
  removeChatComposerAttachment?: (id: string) => void;
  activeChatQuote?: ComposerQuoteState | null;
  onForwardMessage?: (message: Message) => void;
  onOpenMessageDetail?: (message: Message) => void;
  rightDetailRail?: ReactNode;
  setIsDetailPanelCollapsed?: Dispatch<SetStateAction<boolean>>;
  className?: string;
};

export function ChatComposerShell({ children }: ChatComposerShellProps) {
  return <>{children}</>;
}

export function SessionStartingState() {
  return (
    <div
      className="flex h-full min-h-48 items-center justify-center"
      data-session-starting-state="true"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="inline-flex items-center gap-2 text-[13px] font-medium text-[color:var(--utility-muted-text)]">
        <LoaderCircle
          className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
        <span>Starting session…</span>
      </div>
    </div>
  );
}

export function ChatSessionPane({
  viewport,
  presentation,
  actions,
  selection,
}: ChatSessionPaneProps) {
  const {
    sessionKey,
    messages,
    scrollRef,
    scrollClassName,
    onTranscriptScroll,
    hasOlderMessages = false,
    onLoadOlderMessages,
    navigationRequest,
    onNavigationHandled,
    emptyState,
    composer,
    queuedMessages = [],
    onEditQueuedMessage,
    onCancelQueuedMessage,
  } = viewport;
  const {
    liveTurn,
    liveTurnSender,
    shouldRenderLiveTurn,
    isCompressionActive = false,
    plainAgentResponse = false,
    inferLatestHumanReplyTarget = false,
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
    selectedMessageCount = 0,
    onCancelMessageSelection,
    onCopySelectedMessages,
    onForwardSelectedMessages,
    messageSelectionMode = false,
  } = selection;
  const attributedTranscript = useMemo(
    () =>
      buildReplyAttribution(
        messages,
        shouldRenderLiveTurn ? liveTurn : null,
        {
          inferLatestHumanRequest: inferLatestHumanReplyTarget,
          suppressAgentReplyAttribution: plainAgentResponse,
        },
      ),
    [
      inferLatestHumanReplyTarget,
      liveTurn,
      messages,
      plainAgentResponse,
      shouldRenderLiveTurn,
    ],
  );
  const originalIndexByMessageKey = useMemo(
    () =>
      new Map(
        messages.map((message, index) => [
          transcriptWindowMessageIdentity(message, index),
          index,
        ]),
      ),
    [messages],
  );
  const attributedLiveTurn = attributedTranscript.liveTurn ?? liveTurn;
  const liveTurnMessage = useMemo(
    () => shouldRenderLiveTurn && attributedLiveTurn
      ? buildDesktopLiveTurnTranscriptMessage(attributedLiveTurn, liveTurnSender)
      : null,
    [attributedLiveTurn, liveTurnSender, shouldRenderLiveTurn],
  );
  const transcriptMessages = useMemo(() => {
    if (!liveTurnMessage) return attributedTranscript.messages;
    const persistedReplacementIsVisible = attributedTranscript.messages.some(
      (message) => message.id === liveTurnMessage.id,
    );
    return persistedReplacementIsVisible
      ? attributedTranscript.messages
      : [...attributedTranscript.messages, liveTurnMessage];
  }, [attributedTranscript.messages, liveTurnMessage]);
  const transcriptEntries = useMemo(
    () =>
      transcriptMessages.map((message, index) => ({
        message,
        originalIndex:
          originalIndexByMessageKey.get(
            transcriptWindowMessageIdentity(message, index),
          ) ?? index,
      })),
    [originalIndexByMessageKey, transcriptMessages],
  );
  const liveTurnTailKey =
    shouldRenderLiveTurn && attributedLiveTurn
      ? [
          attributedLiveTurn.id,
          attributedLiveTurn.status,
          attributedLiveTurn.completed ? 'complete' : 'active',
          attributedLiveTurn.prompt.length,
          attributedLiveTurn.message.length,
          attributedLiveTurn.assistantText.length,
          attributedLiveTurn.thinkingText.length,
          attributedLiveTurn.tools
            .map((tool) =>
              [
                tool.id,
                tool.status,
                tool.arguments.length,
                tool.liveOutput.length,
                tool.resultText?.length ?? 0,
                tool.detail?.length ?? 0,
              ].join(':'),
            )
            .join(','),
        ].join(':')
      : 'no-live-turn';
  const transcriptTailKey = `${liveTurnTailKey}|${queuedMessages
    .map(
      (message) =>
        `${message.id}:${message.text.length}:${message.attachments.length}`,
    )
    .join(',')}`;
  const handleNavigationReady = useCallback(
    (messageId: string) => {
      navigateToTranscriptMessage(messageId, scrollRef);
    },
    [scrollRef],
  );

  return (
    <>
      <VirtualTranscript
        items={transcriptEntries}
        sessionKey={sessionKey}
        scrollRef={scrollRef}
        scrollClassName={scrollClassName}
        onScroll={() => onTranscriptScroll?.()}
        navigationRequest={navigationRequest}
        onNavigationHandled={onNavigationHandled}
        findNavigationIndex={(entry, messageId) =>
          transcriptWindowMessageMatchesId(
            entry.message,
            messageId,
            entry.originalIndex,
          )
        }
        onNavigationReady={handleNavigationReady}
        hasOlder={hasOlderMessages}
        onLoadOlder={onLoadOlderMessages}
        getItemKey={(entry) =>
          transcriptMessageRenderKey(entry.message, entry.originalIndex)
        }
        renderItem={({ message: msg, originalIndex: idx }) => (
          <div>
            <MessageBubble
              msg={msg}
              onOpenSource={onOpenSource}
              onOpenArtifact={onOpenArtifact}
              onOpenAuthSettings={onOpenAuthSettings}
              onNavigateToMessage={onNavigateToMessage}
              onStopCollaborationAgentRequest={
                onStopCollaborationAgentRequest
              }
              onStopActiveTurn={onStopActiveTurn}
              onRequestCollaborationContact={
                onRequestCollaborationContact
              }
              onOpenSenderProfile={onOpenSenderProfile}
              onForkMessage={onForkMessage}
              messageForks={
                msg.entryId
                  ? messageForksByEntryId?.get(msg.entryId)
                  : undefined
              }
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
              isGroupedWithPrevious={isGroupedWithAdjacentHumanMessage(
                transcriptMessages,
                idx,
                -1,
              )}
              isGroupedWithNext={isGroupedWithAdjacentHumanMessage(
                transcriptMessages,
                idx,
                1,
              )}
            />
            {idx === forkSnapshotBoundaryIndex
            && activeForkSourceSessionId ? (
              <div className="my-2 flex items-center gap-3 px-2 text-[11px] font-medium uppercase tracking-[0.06em] text-sky-300">
                <span
                  className="h-px flex-1 bg-sky-500/30"
                  aria-hidden="true"
                />
                <button
                  type="button"
                  onClick={() =>
                    onSelectSession?.(activeForkSourceSessionId)
                  }
                  disabled={!onSelectSession}
                  className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-sky-300 transition hover:text-sky-200 disabled:cursor-not-allowed disabled:opacity-60"
                  title={`Open the source conversation${
                    activeForkSourceTitle
                      ? ` (${activeForkSourceTitle})`
                      : ''
                  }`}
                >
                  <Split className="h-3 w-3" />
                  <span>Forked from conversation</span>
                </button>
                <span
                  className="h-px flex-1 bg-sky-500/30"
                  aria-hidden="true"
                />
              </div>
            ) : null}
          </div>
        )}
        emptyState={transcriptMessages.length === 0 ? emptyState : null}
        tailKey={transcriptTailKey}
        tail={
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
        }
      />
      {messageSelectionMode && selectedMessageCount > 0 ? (
        <div className="px-5 pt-3">
          <div
            data-message-selection-bar="true"
            className="app-message-selection-bar flex items-center justify-between gap-3 rounded-[22px] border border-[color:var(--app-control-border)] bg-[color:var(--app-modal-bg)] px-3.5 py-2.5 text-[color:var(--utility-foreground)] shadow-[var(--app-shadow-float)] backdrop-blur-[var(--app-glass-blur-float)]"
          >
            <div className="text-[12px] font-semibold tabular-nums">
              {selectedMessageCount} selected
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="rounded-full px-3 py-1.5 text-[12px] font-medium text-[color:var(--utility-muted-text)] transition hover:bg-[color:var(--app-control-hover)] hover:text-[color:var(--utility-foreground)]"
                onClick={onCancelMessageSelection}
              >
                Cancel
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold text-[color:var(--utility-foreground)] transition hover:bg-[color:var(--app-control-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                onClick={onCopySelectedMessages}
                disabled={!onCopySelectedMessages || selectedMessageCount <= 0}
              >
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                Copy
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-full bg-[color:var(--app-sidebar-accent)] px-3 py-1.5 text-[12px] font-semibold text-[color:var(--app-sidebar-accent-text)] transition disabled:cursor-not-allowed disabled:opacity-50"
                onClick={onForwardSelectedMessages}
                disabled={
                  !onForwardSelectedMessages || selectedMessageCount <= 0
                }
              >
                <Send className="h-3.5 w-3.5" aria-hidden="true" />
                Forward
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {composer}
    </>
  );
}
