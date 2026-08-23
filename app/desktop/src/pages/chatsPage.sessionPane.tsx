import { useMemo } from 'react';
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
          Select a conversation, or use + to start an agent session.
        </p>
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
    actions,
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
        <div
          className="flex min-h-0 flex-1 items-center justify-center"
          data-transcript-initial-loading="true"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <div className="inline-flex items-center gap-2 text-[13px] font-medium text-[color:var(--utility-muted-text)]">
            <LoaderCircle
              className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
            <span>{messages[0]?.text}</span>
          </div>
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
