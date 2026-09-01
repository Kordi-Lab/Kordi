import { useLayoutEffect, useMemo, useRef } from 'react';
import type {
  Dispatch,
  ReactNode,
  SetStateAction,
} from 'react';
import {
  Copy,
  LoaderCircle,
  Send,
} from 'lucide-react';

import { buildReplyAttribution } from '@/features/chat/replyAttribution';
import { buildDesktopLiveTurnTranscriptMessage } from '@/features/chat/desktopLiveTurns';
import {
  humanMessageBubbleShapeClass,
  MessageBubbleShapeBackdrop,
} from '@/features/chat/messageBubbleShape';
import { isTranscriptLoadingNotice } from '@/features/chat/transcriptLoadingNotice';
import {
  transcriptWindowMessageIdentity,
} from '@/features/chat/transcriptWindowing';
import type {
  ComposerQuoteState,
  Message,
} from '@/kordi-app/types';
import type {
  ChatAttachment as Attachment,
  ChatSessionPaneActions,
  ChatSessionPaneProps,
} from '@/pages/chatsPage.types';
import { useChatTranscriptViewport } from '@/pages/chatsPage.transcriptViewport';

export type ChatComposerShellProps = {
  children: ReactNode;
  chatComposerAttachments?: Attachment[];
  saveDesktopAttachments?: (files: File[]) => Promise<Attachment[]>;
  saveDesktopAttachmentPaths?: (paths?: string[]) => Promise<Attachment[]>;
  removeChatComposerAttachment?: (id: string) => void;
  activeChatQuote?: ComposerQuoteState | null;
  onForwardMessage?: (message: Message) => void;
  onOpenMessageDetail?: (message: Message) => void;
  rightDetailRail?: ReactNode;
  setIsDetailPanelCollapsed?: Dispatch<SetStateAction<boolean>>;
  className?: string;
};

type TranscriptLoadingPlaceholder = NonNullable<
  Message['loadingPlaceholders']
>[number];

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

export function ChatSelectionEmptyState() {
  return (
    <div
      className="flex h-full min-h-48 items-center justify-center px-8 text-center"
      data-chat-selection-empty-state="true"
    >
      <div className="max-w-sm">
        <div className="text-[14px] font-semibold text-[color:var(--utility-foreground)]">
          No chat selected
        </div>
        <p className="mt-1.5 text-[12px] leading-5 text-[color:var(--utility-muted-text)]">
          Select a conversation, or use + to start a chat.
        </p>
      </div>
    </div>
  );
}

function TranscriptSkeletonHumanRow({
  placeholder,
  compact,
}: {
  placeholder: TranscriptLoadingPlaceholder;
  compact: boolean;
}) {
  const { side, kind, lines, width } = placeholder;
  const own = side === 'own';
  return (
    <div
      className={`flex w-full flex-col gap-1 ${compact ? 'pb-0.5 pt-0.5' : 'pb-1 pt-1'} ${own ? 'items-end' : 'items-start'}`}
      data-transcript-skeleton-kind={kind}
      data-transcript-skeleton-source="cached"
    >
      <div
        className={`flex w-full max-w-full items-end ${compact ? 'gap-1.5' : 'gap-2'} ${own ? 'flex-row-reverse' : 'flex-row'}`}
      >
        <div
          className={`app-transcript-skeleton-surface app-transcript-skeleton-avatar mb-0.5 shrink-0 rounded-full ${compact ? 'h-7 w-7' : 'h-8 w-8'}`}
        />
        <div
          className={`app-message-hover-time-trigger app-transcript-skeleton-bubble min-w-0 max-w-[52rem] text-[14px] shadow-sm ${
            compact
              ? 'app-message-bubble-contact-compact rounded-[8px] px-3 py-1.5'
              : 'px-4 py-2.5'
          } ${
            own
              ? 'app-chat-bubble-user app-transcript-skeleton-bubble-own'
              : 'app-chat-bubble-peer app-transcript-skeleton-bubble-peer'
          } ${humanMessageBubbleShapeClass(side)}`}
          data-transcript-skeleton-width={width}
        >
          <MessageBubbleShapeBackdrop side={side} />
          {kind === 'link' ? (
            <div className="flex items-center gap-2">
              <div className="app-transcript-skeleton-surface app-transcript-skeleton-link-icon shrink-0 rounded-[3px]" />
              <div className="min-w-0 flex-1">
                {Array.from({ length: lines }, (_, index) => (
                  <div
                    key={index}
                    className={`app-transcript-skeleton-surface app-transcript-skeleton-line ${index === lines - 1 && lines > 1 ? 'app-transcript-skeleton-line-short' : 'app-transcript-skeleton-line-long'}`}
                  />
                ))}
              </div>
            </div>
          ) : (
            Array.from({ length: lines }, (_, index) => (
              <div
                key={index}
                className={`app-transcript-skeleton-surface app-transcript-skeleton-line ${index === lines - 1 && lines > 1 ? 'app-transcript-skeleton-line-short' : 'app-transcript-skeleton-line-long'}`}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function TranscriptSkeletonImageRow({
  side,
  compact,
}: {
  side: TranscriptLoadingPlaceholder['side'];
  compact: boolean;
}) {
  const own = side === 'own';
  return (
    <div
      className={`flex w-full flex-col gap-1 ${compact ? 'pb-0.5 pt-0.5' : 'pb-1 pt-1'} ${own ? 'items-end' : 'items-start'}`}
      data-transcript-skeleton-kind="image"
      data-transcript-skeleton-source="cached"
    >
      <div
        className={`flex w-full max-w-full items-start ${compact ? 'gap-1.5' : 'gap-2'} ${own ? 'flex-row-reverse' : 'flex-row'}`}
      >
        <div
          className={`app-transcript-skeleton-surface app-transcript-skeleton-avatar mb-0.5 shrink-0 rounded-full ${compact ? 'h-7 w-7' : 'h-8 w-8'}`}
        />
        <div
          className="min-w-0 w-fit max-w-[31rem] bg-transparent p-0 text-[14px] shadow-none"
          data-message-media-side={side}
        >
          <div className="app-attachment-image-collage relative grid w-[min(100%,20rem)] max-w-[min(100%,29rem)] grid-cols-6 auto-rows-[4rem] gap-0.5 overflow-hidden rounded-[16px] p-0">
            <div className="app-attachment-image-card app-attachment-image-tile app-transcript-skeleton-surface relative col-span-6 row-span-3 overflow-hidden rounded-[16px] bg-black/[0.035]">
              <div className="relative flex h-full min-h-28 aspect-[4/3]" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function TranscriptSkeletonAgentRow({
  placeholder,
}: {
  placeholder: TranscriptLoadingPlaceholder;
}) {
  return (
    <div
      className="flex w-full max-w-[min(100%,61rem)] flex-col items-start py-0.5"
      data-transcript-skeleton-kind="agent"
      data-transcript-skeleton-source="cached"
    >
      <div
        className="app-chat-bubble-agent app-transcript-skeleton-agent max-w-[58rem] rounded-[20px] px-3.5 py-2.5"
        data-transcript-skeleton-width={placeholder.width}
      >
        {Array.from({ length: placeholder.lines }, (_, index) => (
          <div
            key={index}
            className={`app-transcript-skeleton-surface app-transcript-skeleton-line ${index === placeholder.lines - 1 && placeholder.lines > 1 ? 'app-transcript-skeleton-line-short' : 'app-transcript-skeleton-line-long'}`}
          />
        ))}
      </div>
    </div>
  );
}

function TranscriptLoadingSkeleton({
  compact,
  placeholders,
}: {
  compact: boolean;
  placeholders: readonly TranscriptLoadingPlaceholder[];
}) {
  return (
    <div
      className="app-chat-pane-transcript-scroll app-transcript-loading-skeleton flex min-h-0 flex-1 flex-col overflow-hidden"
      data-transcript-loading-skeleton="true"
      aria-hidden="true"
    >
      <div className="flex w-full flex-col gap-1" aria-hidden="true">
        {placeholders.map((placeholder, index) => (
          placeholder.kind === 'image' ? (
            <TranscriptSkeletonImageRow
              key={`${placeholder.kind}:${placeholder.side}:${index}`}
              side={placeholder.side}
              compact={compact}
            />
          ) : placeholder.kind === 'agent' ? (
            <TranscriptSkeletonAgentRow
              key={`${placeholder.kind}:${placeholder.side}:${index}`}
              placeholder={placeholder}
            />
          ) : (
            <TranscriptSkeletonHumanRow
              key={`${placeholder.kind}:${placeholder.side}:${index}`}
              placeholder={placeholder}
              compact={compact}
            />
          )
        ))}
      </div>
    </div>
  );
}

function useStableChatSessionPaneActions(
  actions: ChatSessionPaneActions,
): ChatSessionPaneActions {
  const actionsRef = useRef(actions);
  useLayoutEffect(() => {
    actionsRef.current = actions;
  }, [actions]);
  const delegates = useMemo<ChatSessionPaneActions>(() => ({
    onSelectSession: (sessionId) => actionsRef.current.onSelectSession?.(sessionId),
    onOpenSource: (file) => actionsRef.current.onOpenSource(file),
    onOpenArtifact: (artifactId) => actionsRef.current.onOpenArtifact(artifactId),
    onOpenAuthSettings: () => actionsRef.current.onOpenAuthSettings(),
    onNavigateToMessage: (messageId, sourceMessage) => (
      actionsRef.current.onNavigateToMessage?.(messageId, sourceMessage)
    ),
    onOpenMessageDetail: (message) => actionsRef.current.onOpenMessageDetail?.(message),
    onStopCollaborationAgentRequest: (...args) => (
      actionsRef.current.onStopCollaborationAgentRequest(...args)
    ),
    onStopActiveTurn: () => actionsRef.current.onStopActiveTurn?.(),
    onRequestCollaborationContact: () => actionsRef.current.onRequestCollaborationContact?.(),
    onOpenSenderProfile: (message, anchorRect) => (
      actionsRef.current.onOpenSenderProfile?.(message, anchorRect)
    ),
    onForkMessage: (entryId) => actionsRef.current.onForkMessage?.(entryId),
    onOpenForkSession: (sessionId) => actionsRef.current.onOpenForkSession?.(sessionId),
    onReplyMessage: (message, destination) => actionsRef.current.onReplyMessage?.(message, destination),
    onOpenMessageThread: (message) => actionsRef.current.onOpenMessageThread?.(message),
    onForwardMessage: (message) => actionsRef.current.onForwardMessage?.(message),
    onEditMessage: (message) => actionsRef.current.onEditMessage?.(message),
    onDeleteMessage: (message) => actionsRef.current.onDeleteMessage?.(message),
    onReactMessage: (message, reaction) => actionsRef.current.onReactMessage?.(message, reaction),
    onRetryMessage: (message) => actionsRef.current.onRetryMessage?.(message),
    onSelectMessage: (message) => actionsRef.current.onSelectMessage?.(message),
    onRequestPinMessage: (message) => actionsRef.current.onRequestPinMessage?.(message),
    onRequestUnpinMessage: (message) => actionsRef.current.onRequestUnpinMessage?.(message),
  }), []);
  return {
    ...delegates,
    onSelectSession: actions.onSelectSession ? delegates.onSelectSession : undefined,
    onNavigateToMessage: actions.onNavigateToMessage ? delegates.onNavigateToMessage : undefined,
    onOpenMessageDetail: actions.onOpenMessageDetail ? delegates.onOpenMessageDetail : undefined,
    onStopActiveTurn: actions.onStopActiveTurn ? delegates.onStopActiveTurn : undefined,
    onRequestCollaborationContact: actions.onRequestCollaborationContact
      ? delegates.onRequestCollaborationContact
      : undefined,
    onOpenSenderProfile: actions.onOpenSenderProfile ? delegates.onOpenSenderProfile : undefined,
    onForkMessage: actions.onForkMessage ? delegates.onForkMessage : undefined,
    onOpenForkSession: actions.onOpenForkSession ? delegates.onOpenForkSession : undefined,
    onReplyMessage: actions.onReplyMessage ? delegates.onReplyMessage : undefined,
    onOpenMessageThread: actions.onOpenMessageThread ? delegates.onOpenMessageThread : undefined,
    onForwardMessage: actions.onForwardMessage ? delegates.onForwardMessage : undefined,
    onEditMessage: actions.onEditMessage ? delegates.onEditMessage : undefined,
    onDeleteMessage: actions.onDeleteMessage ? delegates.onDeleteMessage : undefined,
    onReactMessage: actions.onReactMessage ? delegates.onReactMessage : undefined,
    onRetryMessage: actions.onRetryMessage ? delegates.onRetryMessage : undefined,
    onSelectMessage: actions.onSelectMessage ? delegates.onSelectMessage : undefined,
    onRequestPinMessage: actions.onRequestPinMessage ? delegates.onRequestPinMessage : undefined,
    onRequestUnpinMessage: actions.onRequestUnpinMessage
      ? delegates.onRequestUnpinMessage
      : undefined,
  };
}

export function ChatSessionPane({
  viewport,
  presentation,
  actions,
  selection,
}: ChatSessionPaneProps) {
  const stableActions = useStableChatSessionPaneActions(actions);
  const {
    messages,
    composer,
    queuedMessages = [],
  } = viewport;
  const {
    liveTurn,
    liveTurnSender,
    shouldRenderLiveTurn,
    plainAgentResponse = false,
    inferLatestHumanReplyTarget = false,
    densityMode = 'default',
  } = presentation;
  const {
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
  const transcriptViewport = useChatTranscriptViewport({
    viewport,
    presentation,
    actions: stableActions,
    selection,
    transcriptEntries,
    transcriptMessages,
    transcriptTailKey,
  });
  const isInitialTranscriptLoading =
    messages.length === 1 && isTranscriptLoadingNotice(messages[0]);

  return (
    <>
      {isInitialTranscriptLoading ? (
        <div className="contents" data-transcript-initial-loading="true">
          <TranscriptLoadingSkeleton
            compact={densityMode !== 'default'}
            placeholders={messages[0]?.loadingPlaceholders ?? []}
          />
        </div>
      ) : transcriptViewport}
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
                className="app-button-quiet rounded-full px-3 py-1.5 text-[12px] font-medium"
                onClick={onCancelMessageSelection}
              >
                Cancel
              </button>
              <button
                type="button"
                className="app-button-quiet inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold"
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
