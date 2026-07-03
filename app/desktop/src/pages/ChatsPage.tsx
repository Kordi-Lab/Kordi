import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentProps, Dispatch, DragEvent, MouseEventHandler, PointerEvent as ReactPointerEvent, ReactNode, RefObject, SetStateAction } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  ChevronDown,
  ChevronLeft,
  Clock3,
  Cloud,
  Columns2,
  Copy,
  Ellipsis,
  FileText,
  GripVertical,
  Image as ImageIcon,
  Paperclip,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  Send,
  Split,
  SquarePen,
  X,
} from 'lucide-react';

import { AuthNoticeBanner } from '@/components/AuthNoticeBanner';
import { ChatDetailPanel } from '@/pages/ChatDetailPanel';
import { RightDetailRail } from '@/pages/RightDetailRail';
import {
  bridgeAgentRoutingChangeNotice,
  bridgeChatRoutingControlVisibility,
  localOwnedBridgeAgentsForModelRouting,
  routingSelectionForBridgeAgent,
} from '@/features/bridge/agentModelRouting';
import { isCloudBridgeConversationId, isCloudBridgeHostId } from '@/features/cloud/cloudBridgeState';
import type { CloudSelfAgentSyncStatus } from '@/features/cloud/useCloudBridgeState';
import type { CloudSessionPin } from '@/features/cloud/authClient';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { formatSessionIdSubtitle, localOwnedAgentSenderLabel, suppressLiveTurnEchoMessages } from '@/app/viewModels/helpers';
import {
  CompactComposerModelMenu,
  ComposerMentionMenu,
  ComposerModelControls,
  ComposerRuntimeStatus,
  ComposerSlashMenu,
  LiveChatTurnMessage,
  MessageBubble,
  fallbackComposerThinkingValue,
  type ComposerAuthOption,
  type ComposerMentionOption,
  type ComposerModelOption,
  type ComposerProviderOption,
  type CompactComposerModelMenuSaveInput,
} from '@/kordi-app/components';
import type {
  ComposerQuoteState,
  Conversation,
  ConversationParticipant,
  DesktopBridgeHost,
  DesktopChatContextWindowStatus,
  DesktopChatSlashCommand,
  DesktopChatState,
  DesktopChatTurnSnapshot,
  DetailTab,
  EditFilePreview,
  Message,
  MessageSourceReference,
  QueuedDesktopChatMessage,
} from '@/kordi-app/types';
import { useImeCompositionGuard } from '@/features/chat/imeComposition';
import { MessageBubbleShapeBackdrop, queuedMessageBubbleShapeClass } from '@/features/chat/messageBubbleShape';
import { chatComposerPlaceholder } from '@/features/chat/composerCopy';
import { extractClipboardFiles, extractPastedLocalFilePaths } from '@/features/chat/pasteAttachments';
import { buildReplyAttribution, shouldInferLatestHumanReplyTarget, shouldSuppressAgentReplyAttribution } from '@/features/chat/replyAttribution';
import {
  CHAT_COMPOSER_TEXTAREA_SELECTOR,
  focusComposerTextarea,
  focusComposerTextareaForNativeInput,
} from '@/features/chat/composerController.shared';
import { collapseAdjacentSessionConfigNotices } from '@/features/chat/sessionConfigNotices';
import { extractSessionArtifacts } from '@/features/chat/artifacts';
import { transcriptMessageRenderKey } from '@/features/chat/transcriptRenderKeys';
import { resolveTranscriptMessageIdForSource } from '@/features/chat/messageNavigation';
import type { TranscriptDensityMode } from '@/kordi-app/components/transcript';
import { LOCAL_DRAFT_CHAT_CONVERSATION_ID } from '@/features/chat/draftSessions';
import { navigateToTranscriptMessage, scrollTranscriptToBottom } from '@/kordi-app/components/transcriptReplyAttribution';
import { buildForkLineage, isGroupForkSession, isGroupSessionId } from '@/features/chat/forkLineage';
import type { DesktopChatContextMessage } from '@/lib/desktop';
import { cn } from '@/lib/utils';

export const BRIDGE_ROUTING_NOTICE_AUTO_DISMISS_MS = 2000;
export const BRIDGE_ROUTING_NOTICE_EXIT_MS = 180;

function scheduleTranscriptScrollToBottom<T extends HTMLElement>(scrollRef: RefObject<T | null>) {
  if (typeof window === 'undefined') return;
  const scheduleFrame = typeof window.requestAnimationFrame === 'function'
    ? window.requestAnimationFrame.bind(window)
    : (callback: FrameRequestCallback) => window.setTimeout(callback, 0);
  scheduleFrame(() => {
    scheduleFrame(() => scrollTranscriptToBottom(scrollRef as RefObject<HTMLElement | null>));
  });
}

const GENERIC_CHAT_HEADER_SUBTITLES = new Set([
  'agent chat',
  'bridge',
  'cloud',
  'direct chat',
  'direct person chat',
  'draft session',
  'external agent',
  'group',
  'group chat',
  'human',
  'local',
  'my agent',
  'owned',
  'person',
]);

export function isGenericChatHeaderSubtitle(value: string): boolean {
  const normalized = value.trim().replace(/\s+/g, ' ').toLowerCase();
  return normalized.length === 0 || GENERIC_CHAT_HEADER_SUBTITLES.has(normalized);
}

export function chatHeaderSubtitle(conversation: Pick<Conversation, 'subtitle'>): string | null {
  const formatted = formatSessionIdSubtitle(conversation.subtitle).trim();
  if (!formatted || isGenericChatHeaderSubtitle(formatted)) return null;
  return formatted;
}

export function shouldUseCompactModelRouteMenu(conversation: Pick<Conversation, 'type' | 'directness'>): boolean {
  const type = String(conversation.type ?? '').trim().toLowerCase();
  const directness = String(conversation.directness ?? '').trim().toLowerCase();
  return type === 'person' || type === 'group' || directness.includes('group');
}

export function cloudSelfAgentSyncStatusLabel(status?: Pick<CloudSelfAgentSyncStatus, 'state' | 'pendingCount' | 'message'> | null) {
  if (!status) return null;
  if (status.state === 'syncing') {
    const pendingCount = typeof status.pendingCount === 'number' && Number.isFinite(status.pendingCount)
      ? Math.max(0, Math.floor(status.pendingCount))
      : 0;
    return pendingCount > 1 ? `Syncing ${pendingCount}` : 'Syncing';
  }
  if (status.state === 'synced') return 'Synced';
  return 'Sync issue';
}

function humanTranscriptGroupKey(message?: Message) {
  if (!message || message.role === 'system' || message.role === 'action' || message.role === 'edit' || message.turn) return null;
  const senderType = message.senderType ?? (message.role === 'user' || message.role === 'person' ? 'human' : 'agent');
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

function isGroupedWithAdjacentHumanMessage(messages: readonly Message[], index: number, offset: -1 | 1) {
  const currentKey = humanTranscriptGroupKey(messages[index]);
  return Boolean(currentKey && currentKey === humanTranscriptGroupKey(messages[index + offset]));
}

type QueuedMessageBubbleProps = {
  message: QueuedDesktopChatMessage;
  isCompressionActive: boolean;
  onEdit?: (sessionId: string, queuedMessageId: string) => void;
  onCancel?: (sessionId: string, queuedMessageId: string) => void;
};

function QueuedMessageBubble({ message, isCompressionActive, onEdit, onCancel }: QueuedMessageBubbleProps) {
  return (
    <div className="flex justify-end py-0.5">
      <div className={cn('app-queued-message max-w-[min(72%,34rem)] px-3 py-2 text-right', queuedMessageBubbleShapeClass)}>
        <MessageBubbleShapeBackdrop side="own" />
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0 flex-1 text-left">
            <div className="app-queued-message-label mb-0.5 inline-flex items-center gap-1.5 text-[9.5px] font-semibold uppercase tracking-[0.07em]">
              <Clock3 className="h-2.5 w-2.5" />
              <span>{isCompressionActive ? 'Queued during compression' : 'Queued next'}</span>
            </div>
            <div className="app-queued-message-text whitespace-pre-wrap break-words text-[13px] leading-5">{message.text}</div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1 pb-0.5">
            <div className="app-queued-message-meta text-[10px] leading-none">{message.time}</div>
            <div className="flex items-center gap-1" aria-label="Queued message actions">
              <button
                type="button"
                className="app-queued-message-edit inline-flex h-7 w-7 items-center justify-center rounded-full transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-200/70"
                aria-label={`Edit queued message: ${message.text.slice(0, 48)}`}
                title="Edit queued message"
                onClick={() => onEdit?.(message.sessionId, message.id)}
              >
                <SquarePen className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <button
                type="button"
                className="app-queued-message-cancel inline-flex h-7 w-7 items-center justify-center rounded-full transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-200/70"
                aria-label={`Cancel queued message: ${message.text.slice(0, 48)}`}
                title="Cancel queued message"
                onClick={() => onCancel?.(message.sessionId, message.id)}
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
        {message.attachments.length > 0 ? (
          <div className="app-queued-message-meta mt-1 text-[10px] leading-none">
            {message.attachments.length} attachment{message.attachments.length === 1 ? '' : 's'} waiting
          </div>
        ) : null}
      </div>
    </div>
  );
}

function chatMessageActionId(message: Message) {
  return message.id?.trim() || message.entryId?.trim() || message.turn?.id?.trim() || '';
}

function stableCloudPinMessageId(message: Message, conversationId: string) {
  const actionId = chatMessageActionId(message);
  const bridgePrefix = `bridge-message:${conversationId}:`;
  if (actionId.startsWith(bridgePrefix)) {
    return actionId.slice(bridgePrefix.length).trim() || actionId;
  }
  return actionId;
}

function pinnedMessageCandidateIds(message: Message, conversationId: string) {
  return [...new Set([chatMessageActionId(message), stableCloudPinMessageId(message, conversationId)].map((value) => value.trim()).filter(Boolean))];
}

function pinnedMessagePreview(message: Message) {
  const text = message.turn?.assistantText?.trim() || message.text.trim() || message.detail?.trim();
  if (text) return text.replace(/\s+/g, ' ');
  const attachments = message.attachments ?? [];
  if (attachments.length === 1) return attachments[0]?.kind === 'image' ? 'Photo' : attachments[0]?.name || 'Attachment';
  if (attachments.length > 1) return `${attachments.length} attachments`;
  return 'Message';
}

function pinnedMessageSenderLabel(message: Message) {
  const sourceLabel = message.sourceSenderLabel?.trim();
  if (sourceLabel && sourceLabel.toLowerCase() !== 'me') return sourceLabel;
  const sender = message.sender?.trim();
  if (sender && sender.toLowerCase() !== 'me') return sender;
  return sourceLabel || sender || '';
}

export function PinnedMessageBar({
  message,
  onOpenMessage,
  onRequestUnpin,
}: {
  message: Message;
  onOpenMessage?: () => void;
  onRequestUnpin: () => void;
}) {
  const sender = pinnedMessageSenderLabel(message);
  const preview = pinnedMessagePreview(message);
  return (
    <div
      data-pinned-message-bar="true"
      className="app-pinned-message-bar shrink-0 border-b border-[color:var(--app-divider)] px-4 py-2"
      style={{ background: 'color-mix(in srgb, var(--app-panel-bg) 94%, var(--app-text) 6%)' }}
    >
      <div className="flex min-h-9 items-center gap-2.5">
        <Pin className="h-3.5 w-3.5 shrink-0 text-[color:var(--utility-muted-text)]" aria-hidden="true" />
        <button type="button" onClick={onOpenMessage} className="min-w-0 flex-1 text-left" aria-label="Open pinned message">
          <div className="text-[12px] font-medium leading-4 text-[color:var(--utility-muted-text)]">pinged</div>
          <div className="truncate text-[13px] leading-4 text-[color:var(--app-text)]">
            {sender ? `${sender}: ${preview}` : preview}
          </div>
        </button>
        <button
          type="button"
          onClick={onRequestUnpin}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[color:var(--utility-muted-text)] transition hover:bg-[color:var(--app-hover-bg)] hover:text-[color:var(--app-text)] focus:outline-none focus:ring-2 focus:ring-[color:var(--app-focus)]"
          aria-label="Unpin pinned message"
          title="Unpin pinned message"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export function PinMessageDialog({
  mode,
  message: _message,
  pinForEveryone,
  onTogglePinForEveryone,
  onCancel,
  onConfirm,
}: {
  mode: 'pin' | 'unpin';
  message: Message;
  pinForEveryone: boolean;
  onTogglePinForEveryone: (value: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const isPin = mode === 'pin';
  return (
    <div className="fixed inset-0 z-[300] grid place-items-center bg-black/45 px-4" data-pin-message-dialog={mode}>
      <div className="w-full max-w-[28rem] rounded-[16px] bg-white px-6 py-5 text-slate-950 shadow-[0_20px_56px_rgba(15,23,42,0.24)]">
        <div className="text-[15px] font-medium leading-6">
          {isPin ? 'Pin this message?' : 'Unpin this message?'}
        </div>
        {isPin ? (
          <label className="mt-5 flex items-center gap-3 text-[14px] font-medium leading-5">
            <input
              type="checkbox"
              checked={pinForEveryone}
              onChange={(event) => onTogglePinForEveryone(event.currentTarget.checked)}
              className="h-5.5 w-5.5 rounded border-2 border-slate-300"
            />
            <span>Pin for everyone</span>
          </label>
        ) : null}
        <div className="mt-6 flex justify-end gap-6 text-[14px] font-semibold text-pink-500">
          <button type="button" onClick={onCancel} className="rounded-full px-2 py-1 transition hover:bg-pink-50">Cancel</button>
          <button type="button" onClick={onConfirm} className="rounded-full px-2 py-1 transition hover:bg-pink-50">{isPin ? 'Pin' : 'Unpin'}</button>
        </div>
      </div>
    </div>
  );
}

type Attachment = {
  id: string;
  name: string;
  path: string;
  kind: 'image' | 'file';
};

type ChatComposerShellProps = {
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

function ChatComposerShell({ children }: ChatComposerShellProps) {
  return <>{children}</>;
}

type ChatSessionPaneProps = {
  messages: Message[];
  liveTurn?: DesktopChatTurnSnapshot | null;
  liveTurnSender: string;
  shouldRenderLiveTurn: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  scrollClassName: string;
  onTranscriptScroll?: () => void;
  emptyState?: ReactNode;
  composer: ReactNode;
  queuedMessages?: QueuedDesktopChatMessage[];
  onEditQueuedMessage?: (sessionId: string, queuedMessageId: string) => void;
  onCancelQueuedMessage?: (sessionId: string, queuedMessageId: string) => void;
  isCompressionActive?: boolean;
  plainAgentResponse?: boolean;
  forkSnapshotBoundaryIndex?: number;
  activeForkSourceSessionId?: string | null;
  activeForkSourceTitle?: string | null;
  onSelectSession?: (sessionId: string) => void;
  onOpenSource: (file: EditFilePreview) => void;
  onOpenArtifact: (artifactId: string) => void;
  onOpenAuthSettings: () => void;
  onNavigateToMessage?: (messageId: string, sourceMessage?: MessageSourceReference) => void;
  onOpenMessageDetail?: (message: Message) => void;
  onStopBridgeAgentRequest: NonNullable<ComponentProps<typeof MessageBubble>['onStopBridgeAgentRequest']>;
  onStopActiveTurn?: () => void;
  onRequestBridgeContact?: ComponentProps<typeof MessageBubble>['onRequestBridgeContact'];
  onForkMessage?: (entryId: string) => void;
  messageForksByEntryId?: Map<string, Array<{ sessionId: string; title: string; updatedAtLabel?: string }>>;
  onOpenForkSession?: (sessionId: string) => void;
  onReplyMessage?: (message: Message) => void;
  onForwardMessage?: (message: Message) => void;
  onSelectMessage?: (message: Message) => void;
  onRequestPinMessage?: (message: Message) => void;
  onRequestUnpinMessage?: (message: Message) => void;
  pinnedMessageId?: string | null;
  selectionMode?: boolean;
  selectedMessageIds?: ReadonlySet<string>;
  isMessageSelectable?: (message: Message) => boolean;
  onToggleSelectedMessage?: (message: Message) => void;
  onSelectionDragStart?: (message: Message, shouldSelect: boolean) => void;
  onSelectionDragEnter?: (message: Message) => void;
  onSelectionDragEnd?: () => void;
  selectedMessageCount?: number;
  onCancelMessageSelection?: () => void;
  onCopySelectedMessages?: () => void;
  onForwardSelectedMessages?: () => void;
  messageSelectionMode?: boolean;
  densityMode?: TranscriptDensityMode;
  rightDetailRail?: ReactNode;
  setIsDetailPanelCollapsed?: Dispatch<SetStateAction<boolean>>;
};

function ChatSessionPane({
  messages,
  liveTurn,
  liveTurnSender,
  shouldRenderLiveTurn,
  scrollRef,
  scrollClassName,
  onTranscriptScroll,
  emptyState,
  composer,
  queuedMessages = [],
  onEditQueuedMessage,
  onCancelQueuedMessage,
  isCompressionActive = false,
  plainAgentResponse = false,
  forkSnapshotBoundaryIndex = -1,
  activeForkSourceSessionId = null,
  activeForkSourceTitle = null,
  onSelectSession,
  onOpenSource,
  onOpenArtifact,
  onOpenAuthSettings,
  onNavigateToMessage,
  onOpenMessageDetail,
  onStopBridgeAgentRequest,
  onStopActiveTurn,
  onRequestBridgeContact,
  onForkMessage,
  messageForksByEntryId,
  onOpenForkSession,
  onReplyMessage,
  onForwardMessage,
  onSelectMessage,
  onRequestPinMessage,
  onRequestUnpinMessage,
  pinnedMessageId,
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
  densityMode = 'default',
}: ChatSessionPaneProps) {
  return (
    <>
      <ScrollArea
        ref={scrollRef}
        className={scrollClassName}
        onScroll={onTranscriptScroll}
      >
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-1">
          {messages.length > 0 ? messages.map((msg, idx) => (
            <Fragment key={transcriptMessageRenderKey(msg, idx)}>
              <MessageBubble
                msg={msg}
                onOpenSource={onOpenSource}
                onOpenArtifact={onOpenArtifact}
                onOpenAuthSettings={onOpenAuthSettings}
                onNavigateToMessage={onNavigateToMessage}
                onStopBridgeAgentRequest={onStopBridgeAgentRequest}
                onRequestBridgeContact={onRequestBridgeContact}
                onForkMessage={onForkMessage}
                messageForks={msg.entryId ? messageForksByEntryId?.get(msg.entryId) : undefined}
                onOpenForkSession={onOpenForkSession}
                onReplyMessage={onReplyMessage}
                onForwardMessage={onForwardMessage}
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
                isGroupedWithPrevious={isGroupedWithAdjacentHumanMessage(messages, idx, -1)}
                isGroupedWithNext={isGroupedWithAdjacentHumanMessage(messages, idx, 1)}
              />
              {idx === forkSnapshotBoundaryIndex && activeForkSourceSessionId ? (
                <div className="my-2 flex items-center gap-3 px-2 text-[11px] font-medium uppercase tracking-[0.06em] text-sky-300">
                  <span className="h-px flex-1 bg-sky-500/30" aria-hidden="true" />
                  <button
                    type="button"
                    onClick={() => onSelectSession?.(activeForkSourceSessionId)}
                    disabled={!onSelectSession}
                    className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-sky-300 transition hover:text-sky-200 disabled:cursor-not-allowed disabled:opacity-60"
                    title={`Open the source conversation${activeForkSourceTitle ? ` (${activeForkSourceTitle})` : ''}`}
                  >
                    <Split className="h-3 w-3" />
                    <span>Forked from conversation</span>
                  </button>
                  <span className="h-px flex-1 bg-sky-500/30" aria-hidden="true" />
                </div>
              ) : null}
            </Fragment>
          )) : !shouldRenderLiveTurn ? emptyState : null}
          {shouldRenderLiveTurn && liveTurn ? (
            <LiveChatTurnMessage
              turn={liveTurn}
              sender={liveTurnSender}
              onStopBridgeAgentRequest={onStopBridgeAgentRequest}
              onStopActiveTurn={onStopActiveTurn}
              plainAgentResponse={plainAgentResponse}
              onNavigateToMessage={onNavigateToMessage}
              onOpenArtifact={onOpenArtifact}
              onOpenAuthSettings={onOpenAuthSettings}
            />
          ) : null}
          {queuedMessages.map((message) => (
            <QueuedMessageBubble
              key={message.id}
              message={message}
              isCompressionActive={isCompressionActive}
              onEdit={onEditQueuedMessage}
              onCancel={onCancelQueuedMessage}
            />
          ))}
        </motion.div>
      </ScrollArea>
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
                disabled={!onForwardSelectedMessages || selectedMessageCount <= 0}
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

type CompanionSide = 'left' | 'right';

const CHAT_COMPANION_DRAG_TYPE = 'application/x-kordi-chat-companion';

function cleanKey(value?: string | null) {
  return value?.trim().toLowerCase() ?? '';
}

function participantIsSelf(participant: ConversationParticipant) {
  return participant.role === 'self' || (participant.source === 'local' && participant.kind === 'human');
}

function conversationIsGroupChat(conversation: Conversation) {
  return conversation.canonicalSessionId?.startsWith('session:group:') === true
    || conversation.participantSpaceId?.startsWith('group:') === true
    || /\bgroup\b/i.test(conversation.directness ?? '');
}

function conversationIsHumanChat(conversation: Conversation) {
  return conversationIsGroupChat(conversation) || (!conversationIsAgentChat(conversation) && (
    conversation.type === 'person'
    || conversation.canonicalParticipants?.some((participant) => !participantIsSelf(participant) && participant.kind === 'human') === true
  ));
}

function conversationIsAgentChat(conversation: Conversation) {
  return !conversationIsGroupChat(conversation)
    && (conversation.type === 'owned-agent' || conversation.type === 'external-agent');
}

function conversationUsesCompactHumanTranscriptDensity(conversation: Conversation) {
  if (conversationIsAgentChat(conversation)) return false;
  if (conversationIsGroupChat(conversation)) return true;
  if (conversation.type === 'person') return true;
  const directness = conversation.directness?.trim().toLowerCase() ?? '';
  if (/\b(?:direct|person|contact)\b/.test(directness)) return true;
  const nonSelfHumanCount = (conversation.canonicalParticipants ?? [])
    .filter((participant) => !participantIsSelf(participant) && participant.kind === 'human')
    .length;
  return nonSelfHumanCount === 1;
}

function chatTranscriptDensityMode(conversation: Conversation): TranscriptDensityMode {
  if (conversationIsAgentChat(conversation)) return 'agent-compact';
  if (conversationIsGroupChat(conversation)) return 'group-compact';
  if (conversationUsesCompactHumanTranscriptDensity(conversation)) return 'contact-compact';
  return 'default';
}

function addScopedKey(keys: Set<string>, scope: string, value?: string | null) {
  const normalized = cleanKey(value);
  if (normalized) keys.add(`${scope}:${normalized}`);
}

function addPersonRelationshipKey(keys: Set<string>, hostScope: string, value?: string | null) {
  addScopedKey(keys, `${hostScope}:human`, value);
  addScopedKey(keys, `${hostScope}:owner`, value);
}

function conversationRelationshipKeys(conversation: Conversation) {
  const keys = new Set<string>();
  const hostScope = cleanKey(conversation.bridgeTarget?.hostId) || cleanKey(conversation.identity?.bridgeHostId) || 'local';

  addPersonRelationshipKey(keys, hostScope, conversation.bridgeTarget?.humanId);
  addScopedKey(keys, `${hostScope}:node`, conversation.bridgeTarget?.nodeId);
  addScopedKey(keys, `${hostScope}:owner`, conversation.bridgeTarget?.ownerName);
  addPersonRelationshipKey(keys, hostScope, conversation.identity?.remoteHumanId);
  addScopedKey(keys, `${hostScope}:node`, conversation.identity?.remoteHumanNodeId);

  for (const participant of conversation.canonicalParticipants ?? []) {
    if (participantIsSelf(participant)) continue;
    addPersonRelationshipKey(keys, hostScope, participant.id);
    addPersonRelationshipKey(keys, hostScope, participant.humanId);
    addPersonRelationshipKey(keys, hostScope, participant.ownerIdentityId);
    addScopedKey(keys, `${hostScope}:node`, participant.bridgeNodeId);

    if (participant.kind === 'human') {
      addScopedKey(keys, `${hostScope}:owner`, participant.name);
      continue;
    }

    addScopedKey(keys, `${hostScope}:owner`, participant.ownerName);
  }

  return keys;
}

function relationshipKeyOverlap(left: Conversation, right: Conversation) {
  const leftKeys = conversationRelationshipKeys(left);
  if (leftKeys.size === 0) return false;
  for (const key of conversationRelationshipKeys(right)) {
    if (leftKeys.has(key)) return true;
  }
  return false;
}

export function pairedCompanionConversation(activeConv: Conversation, conversations: Conversation[]) {
  const wantsAgent = conversationIsHumanChat(activeConv);
  const wantsHuman = conversationIsAgentChat(activeConv);
  if (!wantsAgent && !wantsHuman) return null;

  return conversations.find((conversation) => (
    conversation.id !== activeConv.id
    && (wantsAgent ? conversationIsAgentChat(conversation) : conversationIsHumanChat(conversation))
    && relationshipKeyOverlap(activeConv, conversation)
  )) ?? null;
}

export function chatCompanionCandidates(activeConv: Conversation, conversations: Conversation[] = []) {
  return conversations.filter((conversation) => (
    conversation.id !== activeConv.id
    && conversationIsAgentChat(conversation)
  ));
}

export function chatSideAgentConversationForOpenRequest(
  requestedConversationId: string | null,
  candidates: Conversation[],
) {
  if (!requestedConversationId) return null;
  return candidates.find((conversation) => conversation.id === requestedConversationId) ?? null;
}

export function parseAskAgentTriggerCommand(text: string) {
  const trimmed = text.trimStart();
  const match = trimmed.match(/^\/ask(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return { prompt: match[1]?.trim() ?? '' };
}

function messageTextForReference(message: Message) {
  const text = message.text?.trim() || message.turn?.assistantText?.trim() || message.detail?.trim() || '';
  return text.replace(/\s+/g, ' ').slice(0, 240);
}

export function buildAskAgentSessionReferenceContext(conversation: Conversation, recentLimit = 6) {
  const sessionId = conversation.canonicalSessionId?.trim() || conversation.id;
  const typeLabel = conversation.directness?.trim() || conversation.type || 'chat';
  const participants = (conversation.canonicalParticipants ?? conversation.participants ?? [])
    .map((participant) => (typeof participant === 'string' ? participant : participant.name)?.trim())
    .filter((name): name is string => Boolean(name))
    .slice(0, 8);
  const recentMessages = conversation.messages
    .filter((message) => message.role !== 'system' && message.role !== 'action')
    .map((message) => ({
      sender: message.sender?.trim() || (message.role === 'user' ? 'Me' : message.role),
      text: messageTextForReference(message),
    }))
    .filter((message) => message.text.length > 0)
    .slice(-Math.max(1, recentLimit));

  return [
    'Reference: Current chat',
    `Session: ${conversation.name}`,
    `Session id: ${sessionId}`,
    `Type: ${typeLabel}`,
    participants.length > 0 ? `Participants: ${participants.join(', ')}` : null,
    recentMessages.length > 0 ? 'Recent messages:' : null,
    ...recentMessages.map((message) => `- ${message.sender}: ${message.text}`),
  ].filter(Boolean).join('\n');
}

export function buildAskAgentSessionReferenceContextMessage(conversation: Conversation, text: string): DesktopChatContextMessage | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const sessionId = conversation.canonicalSessionId?.trim() || conversation.id;
  return {
    id: `ask-agent-reference:${sessionId}`,
    authorName: 'Current chat reference',
    authorKind: 'human',
    text: trimmed,
    createdAtMs: Date.now(),
  };
}

function companionLabel(conversation: Conversation) {
  return conversationPaneKind(conversation) === 'agent' ? 'Agent chat' : 'Human chat';
}

function conversationPaneKind(conversation: Conversation): 'human' | 'agent' | null {
  if (conversationIsGroupChat(conversation)) return 'human';
  if (conversationIsAgentChat(conversation)) return 'agent';
  if (conversationIsHumanChat(conversation)) return 'human';
  return null;
}

function oppositeCompanionSide(side: CompanionSide): CompanionSide {
  return side === 'left' ? 'right' : 'left';
}

export function chatCompanionSideForPaneKinds(
  activeKind: 'human' | 'agent' | null,
  humanSide: CompanionSide,
): CompanionSide {
  if (activeKind === 'human') return oppositeCompanionSide(humanSide);
  if (activeKind === 'agent') return humanSide;
  return oppositeCompanionSide(humanSide);
}

export function humanSideForCompanionSide(
  activeKind: 'human' | 'agent' | null,
  companionSide: CompanionSide,
): CompanionSide {
  if (activeKind === 'agent') return companionSide;
  return oppositeCompanionSide(companionSide);
}

export function chatCompanionSideFromDropPosition(clientX: number, left: number, width: number): CompanionSide {
  return clientX < left + (width / 2) ? 'left' : 'right';
}

function clampChatSplitFraction(value: number) {
  return Math.min(0.68, Math.max(0.32, value));
}

function bridgeModelDisplayName(modelValue?: string | null, modelOptions?: ComposerModelOption[]) {
  if (!modelValue?.trim()) return 'model default';
  const option = modelOptions?.find((candidate) => candidate.value === modelValue);
  return option?.label ?? modelValue;
}

function bridgeThinkingDisplayName(value?: string | null) {
  if (!value?.trim() || value === 'default') return 'model default';
  return value[0]?.toUpperCase() + value.slice(1);
}

export function chatComposerSubmitMode(_input?: {
  isDesktopChatSending?: boolean;
  activeLiveTurnIsRunning?: boolean;
  hasDraft?: boolean;
  canSendWhileBusy?: boolean;
}) {
  // The composer is always in Send mode. Stopping a running turn happens via the
  // inline stop button on the agent message itself (see #267 / #273); keeping a
  // separate stop variant on the composer was redundant and prevented users from
  // queueing a follow-up message while a turn was in flight.
  return 'send' as const;
}

function normalizeRoutingProviderId(providerId: string) {
  const normalized = providerId.trim().toLowerCase();
  return normalized === 'openai-codex' ? 'openai' : normalized;
}

function authChoiceFromProviderOption(option: ComposerProviderOption) {
  return option.value.includes('::') ? option.value.split('::').slice(1).join('::') : null;
}

function firstModelForProvider(providerId: string, modelOptions?: ComposerModelOption[]) {
  const normalized = normalizeRoutingProviderId(providerId);
  return modelOptions?.find((option) => normalizeRoutingProviderId(option.provider ?? '') === normalized)?.value ?? null;
}

function bridgeAuthDisplayName(authProvider?: string | null, authChoice?: string | null, providerOptions?: ComposerProviderOption[]) {
  if (!authProvider?.trim() && !authChoice?.trim()) return null;
  const option = providerOptions?.find((candidate) => (
    candidate.providerId === authProvider && authChoiceFromProviderOption(candidate) === (authChoice ?? null)
  ));
  if (option) return [option.label, option.detail].filter(Boolean).join(' · ');
  return authProvider ?? null;
}

function bridgeRouteDisplayName(
  modelValue?: string | null,
  authProvider?: string | null,
  authChoice?: string | null,
  modelOptions?: ComposerModelOption[],
  providerOptions?: ComposerProviderOption[],
) {
  const model = bridgeModelDisplayName(modelValue, modelOptions);
  const auth = bridgeAuthDisplayName(authProvider, authChoice, providerOptions);
  return auth ? `${auth} · ${model}` : model;
}

type ChatsPageProps = {
  isNativeShell: boolean;
  showChatDetailRail: boolean;
  collapseChatSessions: boolean;
  setIsSessionPanelCollapsed: Dispatch<SetStateAction<boolean>>;
  showRightDetailRail: boolean;
  isDetailPanelCollapsed: boolean;
  setIsDetailPanelCollapsed: Dispatch<SetStateAction<boolean>>;
  rightDetailRail?: ReactNode;
  detailRailWidth?: number;
  activeDetailTab: DetailTab;
  setActiveDetailTab: Dispatch<SetStateAction<DetailTab>>;
  activeArtifactId: string | null;
  setActiveArtifactId: Dispatch<SetStateAction<string | null>>;
  onDetailResizeMouseDown?: MouseEventHandler<HTMLDivElement>;
  activeConv: Conversation;
  chatConversations: Conversation[];
  activeConversationIsBridge: boolean;
  activeBridgeModelHost: DesktopBridgeHost | null;
  desktopChatState: DesktopChatState | null;
  cloudSelfAgentSyncStatus?: CloudSelfAgentSyncStatus | null;
  cloudSessionPin?: CloudSessionPin | null;
  onUpdateCloudSessionPin?: (input: { sessionId: string; messageId: string | null; scope: 'private' | 'shared' }) => Promise<CloudSessionPin>;
  onUpdateBridgeAgentModelRouting: (
    hostId: string,
    agentId: string,
    defaultModel?: string | null,
    fallbackModel?: string | null,
    thinking?: string | null,
    defaultAuthProvider?: string | null,
    defaultAuthChoice?: string | null,
    fallbackAuthProvider?: string | null,
    fallbackAuthChoice?: string | null,
    targetSessionIdOverride?: string | null,
  ) => Promise<void>;
  isEditingDesktopSessionTitle: boolean;
  setIsEditingDesktopSessionTitle: Dispatch<SetStateAction<boolean>>;
  desktopSessionRenameDraft: string;
  setDesktopSessionRenameDraft: Dispatch<SetStateAction<string>>;
  onRenameDesktopSession: (baselineName: string) => Promise<void>;
  chatTranscriptScrollRef: RefObject<HTMLDivElement | null>;
  onTranscriptScroll: () => void;
  onOpenSource: (file: EditFilePreview) => void;
  onOpenArtifact: (artifactId: string) => void;
  desktopLiveTurn: DesktopChatTurnSnapshot | null;
  queuedDesktopMessages: QueuedDesktopChatMessage[];
  queuedDesktopMessagesBySession: Record<string, QueuedDesktopChatMessage[]>;
  onEditQueuedMessage: (sessionId: string, queuedMessageId: string) => void;
  onCancelQueuedMessage: (sessionId: string, queuedMessageId: string) => void;
  filteredChatSlashCommands: DesktopChatSlashCommand[];
  filteredChatMentionTargets: ComposerMentionOption[];
  chatSlashMenuIndex: number;
  setChatSlashMenuIndex: Dispatch<SetStateAction<number>>;
  acceptChatSlashCommand: (value: string) => void;
  acceptChatMentionTarget: (value: string) => void;
  chatAttachmentInputRef: RefObject<HTMLInputElement | null>;
  chatComposerAttachments: Attachment[];
  saveDesktopAttachments: (files: File[]) => Promise<Attachment[]>;
  saveDesktopAttachmentPaths: (paths: string[]) => Promise<Attachment[]>;
  removeChatComposerAttachment: (id: string) => void;
  chatComposerText: string;
  updateChatComposerDraft: (value: string, target: HTMLTextAreaElement) => void;
  setChatComposerText: (value: string) => void;
  setChatComposerTextForSession: (sessionId: string, value: string) => void;
  activeChatQuote?: ComposerQuoteState | null;
  onClearChatQuote?: () => void;
  onReplyMessage?: (message: Message) => void;
  onForwardMessage?: (message: Message) => void;
  onSelectMessage?: (message: Message) => void;
  messageSelectionMode?: boolean;
  selectedMessageCount?: number;
  selectedMessageIds?: ReadonlySet<string>;
  isMessageSelectable?: (message: Message) => boolean;
  onToggleSelectedMessage?: (message: Message) => void;
  onSelectionDragStart?: (message: Message, shouldSelect: boolean) => void;
  onSelectionDragEnter?: (message: Message) => void;
  onSelectionDragEnd?: () => void;
  onCancelMessageSelection?: () => void;
  onCopySelectedMessages?: () => void;
  onForwardSelectedMessages?: () => void;
  composerControlsRef: RefObject<HTMLDivElement | null>;
  activeRuntimeContextStatus?: DesktopChatContextWindowStatus | null;
  activeRuntimeCacheText?: string | null;
  composerSelection: { mode: string; model: string; thinking: string };
  openComposerSelector: { scope: 'chat' | 'project'; type: 'mode' | 'auth' | 'provider' | 'model' | 'thinking' } | null;
  toggleComposerSelector: (scope: 'chat' | 'project', type: 'mode' | 'auth' | 'provider' | 'model' | 'thinking') => void;
  selectComposerValue: (scope: 'chat' | 'project', type: 'mode' | 'auth' | 'provider' | 'model' | 'thinking', value: string, targetSessionIdOverride?: string | null) => void;
  composerAuthLabel: string;
  composerAuthOptions: ComposerAuthOption[];
  selectComposerAuthChoice: (scope: 'chat' | 'project', providerId: string, choice: string, targetSessionIdOverride?: string | null) => void;
  selectComposerProviderChoice: (scope: 'chat' | 'project', option: ComposerProviderOption, targetSessionIdOverride?: string | null) => void;
  composerProviderOptions: ComposerProviderOption[];
  chatModelOptions?: ComposerModelOption[];
  isDesktopChatSending: boolean;
  onStopDesktopChatTurn: () => void;
  onStopBridgeAgentRequest: NonNullable<ComponentProps<typeof MessageBubble>['onStopBridgeAgentRequest']>;
  onRequestBridgeContact?: ComponentProps<typeof MessageBubble>['onRequestBridgeContact'];
  onForkChatMessage?: (sessionId: string, messageEntryId: string) => Promise<void>;
  onSelectSession?: (sessionId: string) => void;
  onSendChatMessage: (draftOverride?: string, targetSessionId?: string, contextMessages?: DesktopChatContextMessage[]) => void;
  onCreateAgentSession?: () => string | null | Promise<string | null>;
  hasAnyAuth: boolean;
  onOpenAuthSettings: () => void;
  onOpenAccountAuthentication?: () => void;
};

export function ChatsPage({
  isNativeShell,
  showChatDetailRail,
  collapseChatSessions,
  setIsSessionPanelCollapsed,
  showRightDetailRail,
  isDetailPanelCollapsed,
  setIsDetailPanelCollapsed,
  rightDetailRail,
  detailRailWidth = 344,
  activeDetailTab,
  setActiveDetailTab,
  activeArtifactId,
  setActiveArtifactId,
  onDetailResizeMouseDown,
  activeConv,
  chatConversations,
  activeConversationIsBridge,
  activeBridgeModelHost,
  desktopChatState,
  cloudSelfAgentSyncStatus,
  cloudSessionPin,
  onUpdateCloudSessionPin,
  onUpdateBridgeAgentModelRouting,
  isEditingDesktopSessionTitle,
  setIsEditingDesktopSessionTitle,
  desktopSessionRenameDraft,
  setDesktopSessionRenameDraft,
  onRenameDesktopSession,
  chatTranscriptScrollRef,
  onTranscriptScroll,
  onOpenSource,
  onOpenArtifact,
  desktopLiveTurn,
  queuedDesktopMessages,
  queuedDesktopMessagesBySession,
  onEditQueuedMessage,
  onCancelQueuedMessage,
  filteredChatSlashCommands,
  filteredChatMentionTargets,
  chatSlashMenuIndex,
  setChatSlashMenuIndex,
  acceptChatSlashCommand,
  acceptChatMentionTarget,
  chatAttachmentInputRef,
  chatComposerAttachments,
  saveDesktopAttachments,
  saveDesktopAttachmentPaths,
  removeChatComposerAttachment,
  chatComposerText,
  updateChatComposerDraft,
  setChatComposerText,
  setChatComposerTextForSession,
  activeChatQuote,
  onClearChatQuote,
  onReplyMessage,
  onForwardMessage,
  onSelectMessage,
  messageSelectionMode = false,
  selectedMessageCount = 0,
  selectedMessageIds,
  isMessageSelectable,
  onToggleSelectedMessage,
  onSelectionDragStart,
  onSelectionDragEnter,
  onSelectionDragEnd,
  onCancelMessageSelection,
  onCopySelectedMessages,
  onForwardSelectedMessages,
  composerControlsRef,
  activeRuntimeContextStatus,
  activeRuntimeCacheText,
  composerSelection,
  openComposerSelector,
  toggleComposerSelector,
  selectComposerValue,
  composerAuthLabel,
  composerAuthOptions,
  selectComposerAuthChoice,
  selectComposerProviderChoice,
  composerProviderOptions,
  chatModelOptions,
  isDesktopChatSending,
  onStopDesktopChatTurn,
  onStopBridgeAgentRequest,
  onRequestBridgeContact,
  onForkChatMessage,
  onSelectSession,
  onSendChatMessage,
  onCreateAgentSession,
  hasAnyAuth,
  onOpenAuthSettings,
  onOpenAccountAuthentication,
}: ChatsPageProps) {
  const openAuthentication = onOpenAccountAuthentication ?? onOpenAuthSettings;
  const authNoticeDescription = onOpenAccountAuthentication
    ? 'Connect a provider, save an API key, or choose a local LM Studio/Ollama server before starting AI chats.'
    : 'Connect a cloud provider, save an API key, or choose a local LM Studio/Ollama server in Authentication before starting AI chats.';
  const authNoticeActionLabel = 'Open authentication';
  const visibleDesktopLiveTurn = desktopLiveTurn ?? (!isNativeShell ? activeConv.previewLiveTurn ?? null : null);
  const isCompressionActive = visibleDesktopLiveTurn?.status === 'compacting';
  const activeLiveTurnIsRunning = Boolean(
    desktopLiveTurn && desktopLiveTurn.sessionId === activeConv.id && !desktopLiveTurn.completed,
  );
  const composerHasDraft = chatComposerText.trim().length > 0 || chatComposerAttachments.length > 0;
  const activeConvHasBridgeTransport = activeConv.bridges.some((bridge) => bridge.trim().toLowerCase() !== 'local');
  const activeSessionSubtitle = chatHeaderSubtitle(activeConv);
  const activeCloudSelfAgentSyncLabel = cloudSelfAgentSyncStatusLabel(cloudSelfAgentSyncStatus);
  const activeTranscriptLiveTurn = visibleDesktopLiveTurn?.sessionId === activeConv.id ? visibleDesktopLiveTurn : undefined;
  const chatComposerPlaceholderText = chatComposerPlaceholder(activeConv);
  const liveTurnSender = localOwnedAgentSenderLabel(activeConv);
  const [selectedBridgeAgentId, setSelectedBridgeAgentId] = useState<string | null>(null);
  const [selectedCompanionBridgeAgentId, setSelectedCompanionBridgeAgentId] = useState<string | null>(null);
  const [bridgeRoutingNotice, setBridgeRoutingNotice] = useState<string | null>(null);
  const [companionBridgeRoutingNotice, setCompanionBridgeRoutingNotice] = useState<string | null>(null);
  const [optimisticBridgeAgentRouting, setOptimisticBridgeAgentRouting] = useState<Record<string, {
    defaultModel?: string | null;
    defaultAuthProvider?: string | null;
    defaultAuthChoice?: string | null;
    fallbackModel?: string | null;
    fallbackAuthProvider?: string | null;
    fallbackAuthChoice?: string | null;
    thinking?: string | null;
  }>>({});
  const [humanPaneSide, setHumanPaneSide] = useState<CompanionSide>('left');
  const [selectedCompanionConversationId, setSelectedCompanionConversationId] = useState<string | null>(null);
  const [openSideAgentConversationId, setOpenSideAgentConversationId] = useState<string | null>(null);
  const [sideAgentReferenceContext, setSideAgentReferenceContext] = useState<string | null>(null);
  const [isSideAgentActionsOpen, setIsSideAgentActionsOpen] = useState(false);
  const [isSideAgentSessionListOpen, setIsSideAgentSessionListOpen] = useState(false);
  const [companionOpenComposerSelector, setCompanionOpenComposerSelector] = useState<{ scope: 'chat' | 'project'; type: 'mode' | 'auth' | 'provider' | 'model' | 'thinking' } | null>(null);
  const [companionDrafts, setCompanionDrafts] = useState<Record<string, string>>({});
  const [companionDropPreviewSide, setCompanionDropPreviewSide] = useState<CompanionSide | null>(null);
  const [isDraggingCompanion, setIsDraggingCompanion] = useState(false);
  const [isCompanionFolded, setIsCompanionFolded] = useState(false);
  const [splitLeftFraction, setSplitLeftFraction] = useState(0.5);
  const [pinnedMessageIdsByConversationId, setPinnedMessageIdsByConversationId] = useState<Record<string, string | null>>({});
  const [optimisticCloudPinBySessionId, setOptimisticCloudPinBySessionId] = useState<Record<string, CloudSessionPin>>({});
  const [pinDialog, setPinDialog] = useState<{ mode: 'pin' | 'unpin'; message: Message } | null>(null);
  const [pinForEveryone, setPinForEveryone] = useState(false);
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  const companionTranscriptScrollRef = useRef<HTMLDivElement | null>(null);
  const companionAttachmentInputRef = useRef<HTMLInputElement | null>(null);
  const [isCompanionDetailPanelCollapsed, setIsCompanionDetailPanelCollapsed] = useState(true);
  const [companionActiveDetailTab, setCompanionActiveDetailTab] = useState<DetailTab>('info');
  const [companionActiveArtifactId, setCompanionActiveArtifactId] = useState<string | null>(null);
  const prefersReducedMotion = useReducedMotion();
  const chatImeCompositionGuard = useImeCompositionGuard();
  const activeSessionId = (activeConv.canonicalSessionId || activeConv.id).trim();
  const activeConversationIsGroupSession = isGroupSessionId(activeSessionId);
  const activeConversationIsGroupFork = isGroupForkSession(activeConv);
  const activeConversationUsesCloudPins = Boolean(
    activeSessionId
      && onUpdateCloudSessionPin
      && (
        activeConv.bridges.some((bridgeId) => isCloudBridgeHostId(bridgeId))
        || isCloudBridgeHostId(activeConv.bridgeTarget?.hostId)
        || isCloudBridgeHostId(activeConv.identity?.bridgeHostId)
        || isCloudBridgeConversationId(activeConv.id)
        || activeConversationIsGroupSession
      ),
  );
  useEffect(() => {
    if (!activeConversationUsesCloudPins || !activeSessionId || cloudSessionPin?.sessionId !== activeSessionId) return;
    setOptimisticCloudPinBySessionId((current) => {
      if (!current[activeSessionId]) return current;
      const next = { ...current };
      delete next[activeSessionId];
      return next;
    });
  }, [
    activeConversationUsesCloudPins,
    activeSessionId,
    cloudSessionPin?.effectiveMessageId,
    cloudSessionPin?.privateMessageId,
    cloudSessionPin?.sessionId,
    cloudSessionPin?.sharedMessageId,
    cloudSessionPin?.updatedAt,
  ]);
  const activeCloudSessionPin = activeConversationUsesCloudPins
    ? optimisticCloudPinBySessionId[activeSessionId] ?? cloudSessionPin ?? null
    : null;
  // Forking is hidden for group chats and historical group-derived forks because
  // the resulting private continuation/visibility semantics are confusing in a
  // shared chat. The local draft and ephemeral bridge transports remain excluded
  // because they have no persistent backing to read from.
  const activeConversationIsForkable = Boolean(
    onForkChatMessage
      && activeConv.id
      && activeConv.id !== LOCAL_DRAFT_CHAT_CONVERSATION_ID
      && !activeConv.id.startsWith('bridge:')
      && !activeConversationIsGroupSession
      && !activeConversationIsGroupFork,
  );
  const handleForkMessage = activeConversationIsForkable && onForkChatMessage
    ? (entryId: string) => {
        void onForkChatMessage(activeConv.id, entryId);
      }
    : undefined;
  const companionCandidates = useMemo(
    () => chatCompanionCandidates(activeConv, chatConversations),
    [activeConv, chatConversations],
  );
  const suggestedCompanionConversation = useMemo(
    () => pairedCompanionConversation(activeConv, companionCandidates) ?? companionCandidates[0] ?? null,
    [activeConv, companionCandidates],
  );
  const selectedCompanionConversation = companionCandidates.find((conversation) => conversation.id === selectedCompanionConversationId) ?? null;
  const suggestedSideAgentConversation = selectedCompanionConversation ?? suggestedCompanionConversation;
  const companionConversation = chatSideAgentConversationForOpenRequest(openSideAgentConversationId, companionCandidates);
  const showCompanionPane = Boolean(companionConversation && !isCompanionFolded);
  const showCompanionDetailRail = showRightDetailRail && Boolean(companionConversation);
  const companionDraftText = companionConversation ? companionDrafts[companionConversation.id] ?? '' : '';
  const activePaneKind = conversationPaneKind(activeConv);
  const canOpenSideAgentPanel = Boolean(suggestedSideAgentConversation || (activePaneKind === 'agent' && onCreateAgentSession));
  const companionPaneKind = companionConversation ? conversationPaneKind(companionConversation) : null;
  const companionSide = chatCompanionSideForPaneKinds(activePaneKind, humanPaneSide);
  const companionConversationHasBridgeTransport = companionConversation?.bridges.some((bridge) => bridge.trim().toLowerCase() !== 'local') ?? false;
  const companionConversationIsBridgeAgent = Boolean(companionPaneKind === 'agent' && companionConversationHasBridgeTransport);
  const companionShowsLocalAgentControls = companionPaneKind === 'agent' && !companionConversationIsBridgeAgent;
  const toggleCompanionComposerSelector = (scope: 'chat' | 'project', type: 'mode' | 'auth' | 'provider' | 'model' | 'thinking') => {
    setCompanionOpenComposerSelector((current) => (current?.scope === scope && current.type === type ? null : { scope, type }));
  };
  const companionSuppressAgentReplyAttribution = companionConversation
    ? shouldSuppressAgentReplyAttribution(companionConversation)
    : false;
  const rawCompanionTranscriptLiveTurn = companionConversation?.previewLiveTurn ?? undefined;
  const companionTranscriptLiveTurn = rawCompanionTranscriptLiveTurn && companionConversation && rawCompanionTranscriptLiveTurn.sessionId === companionConversation.id
    ? rawCompanionTranscriptLiveTurn
    : undefined;
  const companionLiveTurnSender = companionConversation ? localOwnedAgentSenderLabel(companionConversation) : 'Kordi';
  const companionRuntimeContextStatus = companionConversation?.contextWindowStatus ?? null;
  const companionRuntimeCacheText = companionConversation?.cacheMonitorText ?? null;
  const companionBridgeModelHost = useMemo(() => {
    if (!companionConversationIsBridgeAgent) return null;
    const companionHostId = companionConversation?.bridgeTarget?.hostId?.trim() || null;
    if (companionHostId && activeBridgeModelHost?.id === companionHostId) return activeBridgeModelHost;
    if (!companionHostId && activeBridgeModelHost) return activeBridgeModelHost;
    return activeBridgeModelHost;
  }, [activeBridgeModelHost, companionConversation?.bridgeTarget?.hostId, companionConversationIsBridgeAgent]);
  const companionBridgeRoutingAgents = useMemo(
    () => localOwnedBridgeAgentsForModelRouting(companionBridgeModelHost ? [companionBridgeModelHost] : [], desktopChatState),
    [companionBridgeModelHost, desktopChatState],
  );
  const selectedCompanionBridgeRoutingAgentBase = companionBridgeRoutingAgents.find((agent) => agent.id === selectedCompanionBridgeAgentId)
    ?? companionBridgeRoutingAgents.find((agent) => agent.isActive)
    ?? companionBridgeRoutingAgents.find((agent) => agent.isDefault)
    ?? companionBridgeRoutingAgents[0]
    ?? null;
  const selectedCompanionBridgeRoutingKey = selectedCompanionBridgeRoutingAgentBase && companionConversation
    ? isCloudBridgeHostId(selectedCompanionBridgeRoutingAgentBase.hostId)
      ? `${selectedCompanionBridgeRoutingAgentBase.hostId}:${companionConversation.canonicalSessionId ?? companionConversation.id}:${selectedCompanionBridgeRoutingAgentBase.id}`
      : `${selectedCompanionBridgeRoutingAgentBase.hostId}:${selectedCompanionBridgeRoutingAgentBase.id}`
    : null;
  const selectedCompanionBridgeRoutingAgent = selectedCompanionBridgeRoutingAgentBase
    ? {
      ...selectedCompanionBridgeRoutingAgentBase,
      ...(selectedCompanionBridgeRoutingKey ? optimisticBridgeAgentRouting[selectedCompanionBridgeRoutingKey] : null),
    }
    : null;
  const companionBridgeRoutingSelection = routingSelectionForBridgeAgent(selectedCompanionBridgeRoutingAgent);
  const companionBridgeRoutingControlVisibility = bridgeChatRoutingControlVisibility(companionBridgeRoutingAgents.length);
  const companionBridgeAgentSelectorOpen = companionOpenComposerSelector?.scope === 'chat' && companionOpenComposerSelector.type === 'mode';
  const companionBridgeRoutingTargetSessionId = companionConversation?.canonicalSessionId ?? companionConversation?.id ?? null;

  useEffect(() => {
    setOpenSideAgentConversationId(null);
    setSideAgentReferenceContext(null);
    setIsSideAgentActionsOpen(false);
    setIsSideAgentSessionListOpen(false);
    setIsCompanionFolded(false);
  }, [activeConv.id]);

  useEffect(() => {
    if (!showCompanionPane) {
      setIsSideAgentActionsOpen(false);
      setIsSideAgentSessionListOpen(false);
    }
  }, [showCompanionPane]);

  useEffect(() => {
    if (!selectedCompanionConversationId) return;
    if (!companionCandidates.some((conversation) => conversation.id === selectedCompanionConversationId)) {
      setSelectedCompanionConversationId(null);
    }
  }, [companionCandidates, selectedCompanionConversationId]);

  useEffect(() => {
    if (!openSideAgentConversationId) return;
    if (!companionCandidates.some((conversation) => conversation.id === openSideAgentConversationId)) {
      setOpenSideAgentConversationId(null);
      setSideAgentReferenceContext(null);
      setIsCompanionFolded(false);
    }
  }, [companionCandidates, openSideAgentConversationId]);

  // If the active session is itself a fork, show a backlink at the top
  // of the transcript so the user can navigate to the source session.
  const activeForkSourceSessionId = activeConversationIsGroupFork ? null : activeConv.forkedFromSessionId?.trim() || null;
  const activeForkSourceMessageId = activeConversationIsGroupFork ? null : activeConv.forkedFromMessageId?.trim() || null;
  const activeForkSourceTitle = useMemo(() => {
    if (!activeForkSourceSessionId) return null;
    const summary = desktopChatState?.sessions.find((session) => session.id === activeForkSourceSessionId);
    return summary?.title || 'previous session';
  }, [activeForkSourceSessionId, desktopChatState?.sessions]);

  // Build a per-message lookup of forks anchored at each entry id of
  // the active session, so the transcript can render a "N forks" chip
  // and a popover listing them next to the message they branched from.
  const messageForksByEntryId = useMemo(() => {
    if (activeConversationIsGroupSession) return new Map<string, Array<{ sessionId: string; title: string; updatedAtLabel?: string }>>();
    const summaries = (desktopChatState?.sessions ?? []).filter((summary) => !isGroupForkSession(summary));
    const lineage = buildForkLineage(
      summaries.map((summary) => ({
        id: summary.id,
        forkedFromSessionId: summary.forkedFromSessionId ?? null,
        forkedFromMessageId: summary.forkedFromMessageId ?? null,
      })),
    );
    const forksAtMessage = lineage.forksByParentMessageIdBySession.get(activeConv.id);
    if (!forksAtMessage) return new Map<string, Array<{ sessionId: string; title: string; updatedAtLabel?: string }>>();
    const summaryById = new Map(summaries.map((summary) => [summary.id, summary]));
    const result = new Map<string, Array<{ sessionId: string; title: string; updatedAtLabel?: string }>>();
    for (const [messageId, forks] of forksAtMessage) {
      const entries = forks
        .map((fork) => summaryById.get(fork.id))
        .filter((summary): summary is NonNullable<typeof summary> => Boolean(summary))
        .map((summary) => ({
          sessionId: summary.id,
          title: summary.title || 'Untitled fork',
          updatedAtLabel: summary.updatedAtLabel,
        }));
      if (entries.length > 0) result.set(messageId, entries);
    }
    return result;
  }, [activeConv.id, activeConversationIsGroupSession, desktopChatState?.sessions]);
  const bridgeRoutingAgents = useMemo(
    () => localOwnedBridgeAgentsForModelRouting(activeBridgeModelHost ? [activeBridgeModelHost] : [], desktopChatState),
    [activeBridgeModelHost, desktopChatState],
  );
  const selectedBridgeRoutingAgentBase = bridgeRoutingAgents.find((agent) => agent.id === selectedBridgeAgentId)
    ?? bridgeRoutingAgents.find((agent) => agent.isActive)
    ?? bridgeRoutingAgents.find((agent) => agent.isDefault)
    ?? bridgeRoutingAgents[0]
    ?? null;
  const selectedBridgeRoutingKey = selectedBridgeRoutingAgentBase
    ? isCloudBridgeHostId(selectedBridgeRoutingAgentBase.hostId)
      ? `${selectedBridgeRoutingAgentBase.hostId}:${activeConv.canonicalSessionId ?? activeConv.id}:${selectedBridgeRoutingAgentBase.id}`
      : `${selectedBridgeRoutingAgentBase.hostId}:${selectedBridgeRoutingAgentBase.id}`
    : null;
  const selectedBridgeRoutingAgent = selectedBridgeRoutingAgentBase
    ? {
      ...selectedBridgeRoutingAgentBase,
      ...(selectedBridgeRoutingKey ? optimisticBridgeAgentRouting[selectedBridgeRoutingKey] : null),
    }
    : null;
  const bridgeRoutingSelection = routingSelectionForBridgeAgent(selectedBridgeRoutingAgent);
  const bridgeRoutingControlVisibility = bridgeChatRoutingControlVisibility(bridgeRoutingAgents.length);
  const bridgeAgentSelectorOpen = openComposerSelector?.scope === 'chat' && openComposerSelector.type === 'mode';
  const transcriptMessages = collapseAdjacentSessionConfigNotices(
    suppressLiveTurnEchoMessages(activeConv.messages, activeTranscriptLiveTurn),
  );
  const inferLatestHumanReplyTarget = shouldInferLatestHumanReplyTarget(activeConv);
  const suppressAgentReplyAttribution = shouldSuppressAgentReplyAttribution(activeConv);
  const attributedTranscript = useMemo(
    () => buildReplyAttribution(transcriptMessages, activeTranscriptLiveTurn, {
      inferLatestHumanRequest: inferLatestHumanReplyTarget,
      suppressAgentReplyAttribution,
    }),
    [activeTranscriptLiveTurn, inferLatestHumanReplyTarget, suppressAgentReplyAttribution, transcriptMessages],
  );
  const attributedTranscriptMessages = attributedTranscript.messages;
  const pinnedMessageId = activeConversationUsesCloudPins
    ? activeCloudSessionPin?.effectiveMessageId ?? null
    : pinnedMessageIdsByConversationId[activeConv.id] ?? null;
  const pinnedMessage = useMemo(() => {
    if (!pinnedMessageId) return null;
    return attributedTranscriptMessages.find((message) => (
      activeConversationUsesCloudPins
        ? pinnedMessageCandidateIds(message, activeConv.id).includes(pinnedMessageId)
        : chatMessageActionId(message) === pinnedMessageId
    )) ?? null;
  }, [activeConv.id, activeConversationUsesCloudPins, attributedTranscriptMessages, pinnedMessageId]);
  useEffect(() => {
    if (!pinnedMessageId || pinnedMessage || activeConversationUsesCloudPins) return;
    setPinnedMessageIdsByConversationId((current) => ({ ...current, [activeConv.id]: null }));
  }, [activeConv.id, activeConversationUsesCloudPins, pinnedMessage, pinnedMessageId]);
  const requestPinMessage = useCallback((message: Message) => {
    setPinForEveryone(false);
    setPinDialog({ mode: 'pin', message });
  }, []);
  const requestUnpinMessage = useCallback((message: Message) => {
    setPinDialog({ mode: 'unpin', message });
  }, []);
  const handleNavigateToTranscriptMessage = useCallback((messageId: string, sourceMessage?: MessageSourceReference) => {
    const targetMessageId = sourceMessage
      ? resolveTranscriptMessageIdForSource(sourceMessage, attributedTranscriptMessages)
      : messageId;
    navigateToTranscriptMessage(targetMessageId || messageId, chatTranscriptScrollRef);
  }, [attributedTranscriptMessages, chatTranscriptScrollRef]);
  const handleOpenPinnedMessage = useCallback(() => {
    if (!pinnedMessageId) return;
    handleNavigateToTranscriptMessage(pinnedMessage ? chatMessageActionId(pinnedMessage) : pinnedMessageId);
  }, [handleNavigateToTranscriptMessage, pinnedMessage, pinnedMessageId]);
  const handleConfirmPinDialog = useCallback(() => {
    if (!pinDialog) return;
    const messageId = activeConversationUsesCloudPins
      ? stableCloudPinMessageId(pinDialog.message, activeConv.id)
      : chatMessageActionId(pinDialog.message);
    const messageCandidateIds = pinnedMessageCandidateIds(pinDialog.message, activeConv.id);
    setPinDialog(null);
    if (!messageId) return;

    if (activeConversationUsesCloudPins && onUpdateCloudSessionPin && activeSessionId) {
      const sharedPinnedMessageId = activeCloudSessionPin?.sharedMessageId?.trim() ?? '';
      const scope = pinDialog.mode === 'pin'
        ? (pinForEveryone ? 'shared' : 'private')
        : sharedPinnedMessageId && messageCandidateIds.includes(sharedPinnedMessageId) ? 'shared' : 'private';
      const nextMessageId = pinDialog.mode === 'pin' ? messageId : null;
      const now = new Date().toISOString();
      const base: CloudSessionPin = activeCloudSessionPin ?? {
        sessionId: activeSessionId,
        sharedMessageId: null,
        privateMessageId: null,
        effectiveMessageId: null,
        updatedAt: null,
      };
      const optimistic: CloudSessionPin = scope === 'shared'
        ? { ...base, sharedMessageId: nextMessageId, effectiveMessageId: base.privateMessageId || nextMessageId, updatedAt: now }
        : { ...base, privateMessageId: nextMessageId, effectiveMessageId: nextMessageId || base.sharedMessageId, updatedAt: now };
      setOptimisticCloudPinBySessionId((current) => ({ ...current, [activeSessionId]: optimistic }));
      void onUpdateCloudSessionPin({ sessionId: activeSessionId, messageId: nextMessageId, scope })
        .then((pin) => {
          setOptimisticCloudPinBySessionId((current) => ({ ...current, [pin.sessionId]: pin }));
        })
        .catch(() => {
          setOptimisticCloudPinBySessionId((current) => {
            const next = { ...current };
            delete next[activeSessionId];
            return next;
          });
        });
      return;
    }

    setPinnedMessageIdsByConversationId((current) => ({
      ...current,
      [activeConv.id]: pinDialog.mode === 'pin' ? messageId : null,
    }));
  }, [activeCloudSessionPin, activeConv.id, activeConversationUsesCloudPins, activeSessionId, onUpdateCloudSessionPin, pinDialog, pinForEveryone]);
  // Index of the last message that came from the fork's snapshot
  // (everything inherited from the source up through the anchor). The
  // divider goes after this message so any continuation the user
  // sends in the fork shows up below it.
  const forkSnapshotBoundaryIndex = useMemo(() => {
    if (!activeForkSourceSessionId) return -1;
    let lastSnapshotIdx = -1;
    for (let index = 0; index < attributedTranscriptMessages.length; index += 1) {
      const message = attributedTranscriptMessages[index];
      const isAnchor = activeForkSourceMessageId
        && message.entryId === activeForkSourceMessageId;
      if (message.isForkSnapshot || isAnchor) {
        lastSnapshotIdx = index;
      }
    }
    return lastSnapshotIdx;
  }, [activeForkSourceSessionId, activeForkSourceMessageId, attributedTranscriptMessages]);
  const attributedActiveTranscriptLiveTurn = attributedTranscript.liveTurn ?? activeTranscriptLiveTurn;
  const shouldRenderLiveTurn = Boolean(attributedActiveTranscriptLiveTurn && !attributedActiveTranscriptLiveTurn.completed);
  const companionTranscript = useMemo(() => {
    if (!companionConversation) {
      return { messages: [] as Message[], liveTurn: undefined as DesktopChatTurnSnapshot | undefined };
    }
    const messages = collapseAdjacentSessionConfigNotices(
      suppressLiveTurnEchoMessages(companionConversation.messages, companionTranscriptLiveTurn),
    );
    return buildReplyAttribution(messages, companionTranscriptLiveTurn, {
      inferLatestHumanRequest: shouldInferLatestHumanReplyTarget(companionConversation),
      suppressAgentReplyAttribution: companionSuppressAgentReplyAttribution,
    });
  }, [companionConversation, companionSuppressAgentReplyAttribution, companionTranscriptLiveTurn]);
  const companionTranscriptMessages = companionTranscript.messages;
  const handleNavigateToCompanionTranscriptMessage = useCallback((messageId: string, sourceMessage?: MessageSourceReference) => {
    const targetMessageId = sourceMessage
      ? resolveTranscriptMessageIdForSource(sourceMessage, companionTranscriptMessages)
      : messageId;
    navigateToTranscriptMessage(targetMessageId || messageId, companionTranscriptScrollRef);
  }, [companionTranscriptMessages]);
  const attributedCompanionTranscriptLiveTurn = companionTranscript.liveTurn ?? companionTranscriptLiveTurn;
  const shouldRenderCompanionLiveTurn = Boolean(attributedCompanionTranscriptLiveTurn && !attributedCompanionTranscriptLiveTurn.completed);
  const companionLiveTurnIsRunning = Boolean(attributedCompanionTranscriptLiveTurn && !attributedCompanionTranscriptLiveTurn.completed);
  const updateCompanionDropPreview = (event: DragEvent<HTMLElement>) => {
    if (!companionConversation || isCompanionFolded) return null;
    const rect = event.currentTarget.getBoundingClientRect();
    const side = chatCompanionSideFromDropPosition(event.clientX, rect.left, rect.width);
    setCompanionDropPreviewSide(side);
    return side;
  };
  const handleCompanionDragStart = (event: DragEvent<HTMLElement>) => {
    if (!companionConversation) return;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(CHAT_COMPANION_DRAG_TYPE, companionConversation.id);
    setIsDraggingCompanion(true);
    setCompanionDropPreviewSide(companionSide);
  };
  const handleCompanionDragEnd = () => {
    setIsDraggingCompanion(false);
    setCompanionDropPreviewSide(null);
  };
  const handleCompanionDragOver = (event: DragEvent<HTMLElement>) => {
    if (!isDraggingCompanion) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    updateCompanionDropPreview(event);
  };
  const handleCompanionDrop = (event: DragEvent<HTMLElement>) => {
    if (!isDraggingCompanion) return;
    event.preventDefault();
    const side = updateCompanionDropPreview(event);
    if (side) setHumanPaneSide(humanSideForCompanionSide(activePaneKind, side));
    setIsDraggingCompanion(false);
    setCompanionDropPreviewSide(null);
  };
  const updateCompanionDraft = (conversationId: string, value: string, target?: HTMLTextAreaElement) => {
    setCompanionDrafts((current) => ({
      ...current,
      [conversationId]: value,
    }));
    setChatComposerTextForSession(conversationId, value);
    if (!target) return;
    target.style.height = '0px';
    target.style.height = `${Math.min(target.scrollHeight, 160)}px`;
  };
  const sendCompanionDraft = (conversation: Conversation) => {
    const draft = companionDrafts[conversation.id] ?? '';
    if (!draft.trim() && chatComposerAttachments.length === 0) return;
    const referenceContextMessage = sideAgentReferenceContext
      ? buildAskAgentSessionReferenceContextMessage(activeConv, sideAgentReferenceContext)
      : null;
    const contextMessages = referenceContextMessage ? [referenceContextMessage] : [];
    onSendChatMessage(draft, conversation.id, contextMessages);
    scheduleTranscriptScrollToBottom(companionTranscriptScrollRef);
    setCompanionDrafts((current) => {
      const next = { ...current };
      delete next[conversation.id];
      return next;
    });
  };
  const closeCompanionBridgeRoutingSelector = (type: 'provider' | 'model' | 'thinking') => {
    if (companionOpenComposerSelector?.scope === 'chat' && companionOpenComposerSelector.type === type) {
      setCompanionOpenComposerSelector(null);
    }
  };
  const companionDefaultThinkingForBridgeModel = (modelValue: string | null | undefined, currentThinking: string | null | undefined) => {
    const thinkingLevels = chatModelOptions?.find((option) => option.value === modelValue)?.thinkingLevels ?? [];
    return fallbackComposerThinkingValue(thinkingLevels, currentThinking ?? 'default');
  };
  const updateCompanionBridgeAgentRouting = ({
    defaultModel,
    defaultAuthProvider,
    defaultAuthChoice,
    fallbackModel,
    fallbackAuthProvider,
    fallbackAuthChoice,
    thinking,
    selectorType,
  }: {
    defaultModel?: string | null;
    defaultAuthProvider?: string | null;
    defaultAuthChoice?: string | null;
    fallbackModel?: string | null;
    fallbackAuthProvider?: string | null;
    fallbackAuthChoice?: string | null;
    thinking?: string | null;
    selectorType?: 'provider' | 'model' | 'thinking';
  }) => {
    if (selectorType) closeCompanionBridgeRoutingSelector(selectorType);
    if (!selectedCompanionBridgeRoutingAgent || !selectedCompanionBridgeRoutingKey) return;
    if (isDesktopChatSending || companionLiveTurnIsRunning) {
      setCompanionBridgeRoutingNotice("Stop the running task before changing this session's model or thinking level.");
      return;
    }

    const currentModel = selectedCompanionBridgeRoutingAgent.defaultModel ?? null;
    const currentDefaultAuthProvider = selectedCompanionBridgeRoutingAgent.defaultAuthProvider ?? null;
    const currentDefaultAuthChoice = selectedCompanionBridgeRoutingAgent.defaultAuthChoice ?? null;
    const currentFallback = selectedCompanionBridgeRoutingAgent.fallbackModel ?? null;
    const currentFallbackAuthProvider = selectedCompanionBridgeRoutingAgent.fallbackAuthProvider ?? null;
    const currentFallbackAuthChoice = selectedCompanionBridgeRoutingAgent.fallbackAuthChoice ?? null;
    const currentThinking = selectedCompanionBridgeRoutingAgent.thinking ?? null;
    const nextModel = defaultModel !== undefined ? defaultModel : currentModel;
    const nextDefaultAuthProvider = defaultAuthProvider !== undefined ? defaultAuthProvider : currentDefaultAuthProvider;
    const nextDefaultAuthChoice = defaultAuthChoice !== undefined ? defaultAuthChoice : currentDefaultAuthChoice;
    const nextFallback = fallbackModel !== undefined ? fallbackModel : currentFallback;
    const nextFallbackAuthProvider = fallbackAuthProvider !== undefined ? fallbackAuthProvider : currentFallbackAuthProvider;
    const nextFallbackAuthChoice = fallbackAuthChoice !== undefined ? fallbackAuthChoice : currentFallbackAuthChoice;
    const nextThinking = thinking !== undefined ? thinking : currentThinking;
    const defaultAuthChanged = (defaultAuthProvider !== undefined && nextDefaultAuthProvider !== currentDefaultAuthProvider)
      || (defaultAuthChoice !== undefined && nextDefaultAuthChoice !== currentDefaultAuthChoice);
    const fallbackAuthChanged = (fallbackAuthProvider !== undefined && nextFallbackAuthProvider !== currentFallbackAuthProvider)
      || (fallbackAuthChoice !== undefined && nextFallbackAuthChoice !== currentFallbackAuthChoice);
    const noticeText = bridgeAgentRoutingChangeNotice({
      agentLabel: selectedCompanionBridgeRoutingAgent.label,
      currentModel,
      nextModel: defaultModel,
      currentThinking,
      nextThinking: thinking,
      modelLabel: bridgeRouteDisplayName(nextModel, nextDefaultAuthProvider, nextDefaultAuthChoice, chatModelOptions, composerProviderOptions),
      thinkingLabel: bridgeThinkingDisplayName(nextThinking),
    }) ?? ((defaultAuthChanged || fallbackAuthChanged)
      ? `${selectedCompanionBridgeRoutingAgent.label} model route changed to ${bridgeRouteDisplayName(nextModel, nextDefaultAuthProvider, nextDefaultAuthChoice, chatModelOptions, composerProviderOptions)}. Only you can see this.`
      : null);
    if (!noticeText) return;

    setOptimisticBridgeAgentRouting((current) => ({
      ...current,
      [selectedCompanionBridgeRoutingKey]: {
        defaultModel: nextModel,
        defaultAuthProvider: nextDefaultAuthProvider,
        defaultAuthChoice: nextDefaultAuthChoice,
        fallbackModel: nextFallback,
        fallbackAuthProvider: nextFallbackAuthProvider,
        fallbackAuthChoice: nextFallbackAuthChoice,
        thinking: nextThinking,
      },
    }));
    setCompanionBridgeRoutingNotice(noticeText);
    void onUpdateBridgeAgentModelRouting(
      selectedCompanionBridgeRoutingAgent.hostId,
      selectedCompanionBridgeRoutingAgent.id,
      nextModel,
      nextFallback,
      nextThinking,
      nextDefaultAuthProvider,
      nextDefaultAuthChoice,
      nextFallbackAuthProvider,
      nextFallbackAuthChoice,
      companionBridgeRoutingTargetSessionId,
    ).catch((error) => {
      setCompanionBridgeRoutingNotice(error instanceof Error ? error.message : 'Unable to update bridge agent model routing');
    });
  };
  const createSideAgentSession = async (initialPrompt = '') => {
    if (!onCreateAgentSession) return false;
    const createdConversationId = await onCreateAgentSession();
    if (!createdConversationId) return false;
    setHumanPaneSide(humanSideForCompanionSide(activePaneKind, 'right'));
    setOpenSideAgentConversationId(createdConversationId);
    setSelectedCompanionConversationId(createdConversationId);
    setSideAgentReferenceContext(buildAskAgentSessionReferenceContext(activeConv));
    setIsCompanionFolded(false);
    const trimmedPrompt = initialPrompt.trim();
    if (trimmedPrompt) {
      updateCompanionDraft(createdConversationId, trimmedPrompt);
    }
    return true;
  };
  const openSideAgentPanel = async (initialPrompt = '') => {
    if (activePaneKind === 'agent' && onCreateAgentSession) {
      return createSideAgentSession(initialPrompt);
    }
    const targetConversation = selectedCompanionConversation ?? suggestedSideAgentConversation;
    if (!targetConversation) return false;
    setHumanPaneSide(humanSideForCompanionSide(activePaneKind, 'right'));
    setOpenSideAgentConversationId(targetConversation.id);
    setSelectedCompanionConversationId(targetConversation.id);
    setSideAgentReferenceContext(buildAskAgentSessionReferenceContext(activeConv));
    setIsCompanionFolded(false);
    const trimmedPrompt = initialPrompt.trim();
    if (trimmedPrompt) {
      updateCompanionDraft(targetConversation.id, trimmedPrompt);
    }
    return true;
  };
  const handleSendChatMessage = (draftOverride?: string) => {
    const draft = draftOverride ?? chatComposerText;
    const trigger = parseAskAgentTriggerCommand(draft);
    if (trigger) {
      void openSideAgentPanel(trigger.prompt).then((opened) => {
        if (opened) setChatComposerText('');
      });
      return;
    }
    const shouldJumpToSentMessage = draft.trim().length > 0 || chatComposerAttachments.length > 0;
    onSendChatMessage(draftOverride);
    if (shouldJumpToSentMessage) {
      scheduleTranscriptScrollToBottom(chatTranscriptScrollRef);
    }
  };
  const updateSplitFromPointer = (clientX: number) => {
    const container = splitContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0) return;
    setSplitLeftFraction(clampChatSplitFraction((clientX - rect.left) / rect.width));
  };
  const handleSplitDividerPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    updateSplitFromPointer(event.clientX);
  };
  const handleSplitDividerPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    updateSplitFromPointer(event.clientX);
  };
  const handleSplitDividerPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const companionPane = companionConversation ? (
    <aside className="app-chat-companion-pane flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-white/[0.025]" data-side={companionSide} data-chat-side-agent-panel="true">
      <div
        className="app-page-header relative z-40 flex min-h-[72px] shrink-0 cursor-grab items-center justify-between gap-3 border-b border-white/[0.06] px-4 py-2.5 active:cursor-grabbing"
        draggable
        onDragStart={handleCompanionDragStart}
        onDragEnd={handleCompanionDragEnd}
        title={`Drag to move ${companionLabel(companionConversation)} left or right`}
      >
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex min-w-0 items-center gap-1.5 text-white">
              <span className="min-w-0 max-w-[18rem] truncate text-[17px] font-semibold leading-6">Ask Agent · {companionConversation.name}</span>
              <span data-chat-session-subtitle-pill="true" className="inline-flex h-5 shrink-0 items-center rounded-full border border-white/10 bg-white/[0.045] px-2 text-[10.5px] font-medium leading-none text-slate-300">Agent session</span>
            </div>
          </div>
        </div>
        <div
          className="relative flex shrink-0 items-center gap-0.5"
          draggable={false}
          onDragStart={(event) => event.preventDefault()}
          onPointerDown={(event) => event.stopPropagation()}
          aria-label="Side chat controls"
          data-side-chat-controls="true"
        >
          <button
            type="button"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full p-0 text-[color:var(--utility-muted-text)] opacity-70 transition hover:bg-[color:var(--app-control-hover)] hover:text-[color:var(--utility-foreground)] hover:opacity-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-[color:var(--app-sidebar-accent)]"
            title="Side chat options"
            aria-label="Side chat options"
            onClick={() => {
              setIsSideAgentActionsOpen((open) => !open);
              setIsSideAgentSessionListOpen(false);
            }}
          >
            <Ellipsis className="h-3.5 w-3.5" />
          </button>
          {isSideAgentActionsOpen ? (
            <div
              data-side-chat-options-menu="true"
              data-side-chat-root-menu="true"
              className="absolute right-8 top-full z-50 mt-2 w-44 rounded-[18px] border border-[color:var(--app-divider)] bg-[var(--app-modal-bg)] p-1.5 text-[13px] font-medium text-[color:var(--utility-foreground)] shadow-[var(--app-shadow-float)] backdrop-blur-xl"
            >
              {isSideAgentSessionListOpen ? (
                <div data-side-chat-session-list="true">
                  <button
                    type="button"
                    className="mb-1 flex w-full items-center gap-2 rounded-[12px] px-2 py-1.5 text-left text-[13px] transition hover:bg-[color:var(--app-control-hover)]"
                    onClick={() => setIsSideAgentSessionListOpen(false)}
                  >
                    <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                    <span>Back</span>
                  </button>
                  <div className="mb-1 h-px bg-[color:var(--app-divider)]" aria-hidden="true" />
                  {companionCandidates.map((conversation) => (
                    <button
                      key={conversation.id}
                      type="button"
                      className={cn(
                        'flex w-full items-center justify-between gap-2 rounded-[12px] px-2.5 py-1.5 text-left text-[13px] transition hover:bg-[color:var(--app-control-hover)]',
                        conversation.id === companionConversation.id ? 'text-pink-500 dark:text-pink-200' : 'text-[color:var(--utility-foreground)]',
                      )}
                      title={`Switch to ${conversation.name}`}
                      onClick={() => {
                        setSelectedCompanionConversationId(conversation.id);
                        setOpenSideAgentConversationId(conversation.id);
                        setIsSideAgentActionsOpen(false);
                        setIsSideAgentSessionListOpen(false);
                        setCompanionOpenComposerSelector(null);
                      }}
                    >
                      <span className="truncate">{conversation.name}</span>
                      {conversation.id === companionConversation.id ? (
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-pink-300" aria-hidden="true" />
                      ) : null}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="space-y-1">
                  {onCreateAgentSession ? (
                    <button
                      type="button"
                      className="flex w-full items-center gap-2.5 rounded-[12px] px-2.5 py-2 text-left transition hover:bg-[color:var(--app-control-hover)]"
                      title="New chat"
                      aria-label="New chat"
                      onClick={() => {
                        setIsSideAgentActionsOpen(false);
                        setIsSideAgentSessionListOpen(false);
                        void createSideAgentSession();
                      }}
                    >
                      <SquarePen className="h-4 w-4 shrink-0" aria-hidden="true" />
                      <span className="truncate">New chat</span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-2.5 rounded-[12px] px-2.5 py-2 text-left transition hover:bg-[color:var(--app-control-hover)]"
                    onClick={() => setIsSideAgentSessionListOpen(true)}
                  >
                    <span>Switch Chat</span>
                    <ChevronDown className="h-4 w-4 -rotate-90" aria-hidden="true" />
                  </button>
                </div>
              )}
            </div>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setOpenSideAgentConversationId(null);
              setSelectedCompanionConversationId(null);
              setSideAgentReferenceContext(null);
              setIsSideAgentActionsOpen(false);
              setIsSideAgentSessionListOpen(false);
              setCompanionOpenComposerSelector(null);
            }}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full p-0 text-[color:var(--utility-muted-text)] opacity-70 transition hover:bg-[color:var(--app-control-hover)] hover:text-[color:var(--utility-foreground)] hover:opacity-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-[color:var(--app-sidebar-accent)]"
            title="Close side chat"
            aria-label="Close side chat"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <ChatSessionPane
        messages={companionTranscriptMessages}
        liveTurn={attributedCompanionTranscriptLiveTurn}
        liveTurnSender={companionLiveTurnSender}
        shouldRenderLiveTurn={shouldRenderCompanionLiveTurn}
        scrollRef={companionTranscriptScrollRef}
        scrollClassName="min-h-0 flex-1 overflow-x-hidden overscroll-contain px-3 py-5"
        densityMode={chatTranscriptDensityMode(companionConversation)}
        queuedMessages={queuedDesktopMessagesBySession[companionConversation.id] ?? []}
        onEditQueuedMessage={onEditQueuedMessage}
        onCancelQueuedMessage={onCancelQueuedMessage}
        emptyState={(
          <div className="flex h-full min-h-[12rem] items-center justify-center px-4 text-center text-[12px] text-slate-500">
            No messages in this side chat yet.
          </div>
        )}
        plainAgentResponse={companionSuppressAgentReplyAttribution}
        onOpenSource={onOpenSource}
        onOpenArtifact={onOpenArtifact}
        onOpenAuthSettings={openAuthentication}
        onNavigateToMessage={handleNavigateToCompanionTranscriptMessage}
        onOpenMessageDetail={onSelectMessage}
        onStopBridgeAgentRequest={onStopBridgeAgentRequest}
        onStopActiveTurn={onStopDesktopChatTurn}
        onRequestBridgeContact={onRequestBridgeContact}
        onForkMessage={onForkChatMessage ? (entryId) => {
          void onForkChatMessage(companionConversation.id, entryId);
        } : undefined}
        onOpenForkSession={onSelectSession}
        onForwardMessage={onForwardMessage}
        onSelectMessage={onSelectMessage}
        rightDetailRail={rightDetailRail}
        setIsDetailPanelCollapsed={setIsDetailPanelCollapsed}
        composer={(
          <ChatComposerShell
            className="pt-3"
            chatComposerAttachments={chatComposerAttachments}
            saveDesktopAttachments={saveDesktopAttachments}
            saveDesktopAttachmentPaths={saveDesktopAttachmentPaths}
            removeChatComposerAttachment={removeChatComposerAttachment}
            activeChatQuote={activeChatQuote}
            onForwardMessage={onForwardMessage}
            rightDetailRail={rightDetailRail}
            setIsDetailPanelCollapsed={setIsDetailPanelCollapsed}
          >
            <div data-companion-composer-frame="true" className="shrink-0 px-5 pb-4 pt-3">
              <div className="app-composer-shell rounded-[26px] p-3" data-companion-composer-footer="true">
              <div className="relative">
                <div
                  className={cn(
                    'app-composer-input rounded-[18px] transition',
                    chatComposerAttachments.length > 0 ? 'px-3 pb-1.5 pt-1' : 'px-4 py-2.5',
                  )}
                >
                  <input
                    ref={companionAttachmentInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(event) => {
                      const files = Array.from(event.target.files ?? []);
                      if (files.length > 0) {
                        void saveDesktopAttachments(files);
                      }
                      event.currentTarget.value = '';
                    }}
                  />
                  {chatComposerAttachments.length > 0 ? (
                    <div className="mb-1 flex flex-wrap items-center gap-1.5">
                      {chatComposerAttachments.map((attachment) => (
                        <div
                          key={attachment.id}
                          className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-[color:var(--app-divider)] bg-[color:var(--app-control-bg)] px-2.5 text-[11px] text-[color:var(--utility-foreground)]"
                        >
                          {attachment.kind === 'image' ? <ImageIcon className="h-3.5 w-3.5 shrink-0 text-sky-300" /> : <FileText className="h-3.5 w-3.5 shrink-0 text-slate-300" />}
                          <span className="max-w-[220px] truncate leading-none">{attachment.name}</span>
                          <button
                            type="button"
                            onClick={() => removeChatComposerAttachment(attachment.id)}
                            className="text-[color:var(--utility-muted-text)] transition hover:text-[color:var(--utility-foreground)]"
                            aria-label={`Remove ${attachment.name}`}
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <textarea
                    rows={1}
                    value={companionDraftText}
                    onPointerDown={(event) => event.stopPropagation()}
                    onChange={(event) => updateCompanionDraft(companionConversation.id, event.target.value, event.target)}
                    onPaste={(event) => {
                      const files = extractClipboardFiles(event.clipboardData);
                      if (files.length > 0) {
                        event.preventDefault();
                        void saveDesktopAttachments(files);
                        return;
                      }

                      const pastedPaths = extractPastedLocalFilePaths(
                        event.clipboardData.getData('text/plain'),
                        event.clipboardData.getData('text/uri-list'),
                      );
                      if (pastedPaths.length > 0) {
                        event.preventDefault();
                        void saveDesktopAttachmentPaths(pastedPaths);
                      }
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
                        event.preventDefault();
                        sendCompanionDraft(companionConversation);
                      }
                    }}
                    className="min-h-[24px] max-h-[220px] w-full resize-none overflow-y-auto bg-transparent px-0 py-0 text-[15px] leading-6 text-[color:var(--utility-foreground)] outline-none placeholder:text-[color:var(--utility-muted-text)]"
                    placeholder={companionPaneKind === 'agent' ? 'Ask the agent…' : `Message ${companionConversation.name}`}
                    data-composer-scope="chat"
                  />
                </div>
              </div>
              <AnimatePresence initial={false}>
                {companionConversationIsBridgeAgent && companionBridgeRoutingNotice ? (
                  <motion.div
                    key={companionBridgeRoutingNotice}
                    className="mb-2 flex justify-center"
                    role="status"
                    aria-live="polite"
                    initial={{ opacity: 0, y: prefersReducedMotion ? 0 : 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: prefersReducedMotion ? 0 : -4 }}
                    transition={{ duration: prefersReducedMotion ? 0.01 : BRIDGE_ROUTING_NOTICE_EXIT_MS / 1000, ease: [0.22, 1, 0.36, 1] }}
                  >
                    <div className="max-w-[min(100%,38rem)] truncate rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-center text-[11px] text-slate-300">
                      Private · {companionBridgeRoutingNotice}
                    </div>
                  </motion.div>
                ) : null}
              </AnimatePresence>
              <div data-companion-send-row="true" className="app-composer-meta mt-2 flex flex-nowrap items-center justify-between gap-3 pt-2.5">
                <div className="flex shrink-0 items-center gap-2 overflow-visible pr-1">
                  <Button
                    size="icon"
                    variant="secondary"
                    className="app-icon-button h-9 w-9 shrink-0 rounded-full border-0"
                    onClick={() => companionAttachmentInputRef.current?.click()}
                    title="Add attachment"
                    aria-label="Add attachment"
                    data-companion-attachment-control="true"
                  >
                    <Paperclip className="h-4 w-4" />
                  </Button>
                </div>
                <div className="flex min-w-0 flex-1 items-center justify-end gap-2 overflow-visible">
                  {companionShowsLocalAgentControls ? (
                    <div className="flex min-w-0 flex-nowrap items-center justify-end gap-2 overflow-visible" data-companion-model-controls="true">
                      {isNativeShell || companionRuntimeContextStatus ? (
                        <ComposerRuntimeStatus
                          contextStatus={companionRuntimeContextStatus}
                          cacheText={companionRuntimeCacheText}
                        />
                      ) : null}
                      <div className="min-w-0 max-w-full overflow-visible">
                        <ComposerModelControls
                          scope="chat"
                          selection={composerSelection}
                          openSelector={companionOpenComposerSelector}
                          onToggleSelector={toggleCompanionComposerSelector}
                          onSelectValue={(scope, type, value) => {
                            setCompanionOpenComposerSelector(null);
                            void selectComposerValue(scope, type, value, companionConversation.id);
                          }}
                          authLabel={composerAuthLabel}
                          authOptions={composerAuthOptions}
                          onSelectAuthChoice={(scope, providerId, choice) => {
                            setCompanionOpenComposerSelector(null);
                            void selectComposerAuthChoice(scope, providerId, choice, companionConversation.id);
                          }}
                          onSelectProviderChoice={(scope, option) => {
                            setCompanionOpenComposerSelector(null);
                            void selectComposerProviderChoice(scope, option, companionConversation.id);
                          }}
                          providerOptions={composerProviderOptions}
                          modelOptions={chatModelOptions && chatModelOptions.length > 0 ? chatModelOptions : undefined}
                          compact={true}
                        />
                      </div>
                    </div>
                  ) : companionConversationIsBridgeAgent && selectedCompanionBridgeRoutingAgent ? (
                    <div className="relative flex min-w-0 flex-nowrap items-center justify-end gap-2 overflow-visible" data-companion-model-controls="true" data-companion-bridge-model-controls="true">
                      {companionBridgeRoutingControlVisibility.showAgentSelector ? (
                        <button
                          type="button"
                          onClick={() => toggleCompanionComposerSelector('chat', 'mode')}
                          className="inline-flex max-w-[10rem] items-center gap-1.5 rounded-full px-1 py-0.5 text-[12px] font-medium text-slate-300 transition hover:text-white"
                          title="Choose which owned agent these session settings apply to"
                        >
                          <span className="truncate">{selectedCompanionBridgeRoutingAgent.label}</span>
                          <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform', companionBridgeAgentSelectorOpen ? 'rotate-180 text-slate-300' : '')} />
                        </button>
                      ) : null}
                      {companionBridgeAgentSelectorOpen ? (
                        <div className="absolute bottom-full right-0 z-30 mb-2 max-h-[min(22rem,50vh)] w-[260px] overflow-y-auto rounded-[14px] border border-[color:var(--app-divider)] bg-[var(--app-modal-bg)] px-3 py-3 text-[12px] shadow-[var(--app-shadow-float)] backdrop-blur-xl">
                          <div className="pb-2 text-[12px] font-medium text-[color:var(--utility-foreground)]">My agent</div>
                          <div className="space-y-1">
                            {companionBridgeRoutingAgents.map((agent) => (
                              <button
                                key={`${agent.hostId}:${agent.id}`}
                                type="button"
                                onClick={() => {
                                  setSelectedCompanionBridgeAgentId(agent.id);
                                  setCompanionOpenComposerSelector(null);
                                }}
                                className={cn(
                                  'app-composer-popover-item flex w-full items-center justify-between px-3 py-2.5 text-left text-[13px]',
                                  selectedCompanionBridgeRoutingAgent.id === agent.id ? 'app-composer-popover-item-active' : '',
                                )}
                              >
                                <span className="truncate">{agent.label}</span>
                                <span className="shrink-0 text-[11px] text-[color:var(--utility-muted-text)]">{agent.isDefault ? 'Default' : 'Owned'}</span>
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : null}
                      <ComposerModelControls
                        scope="chat"
                        selection={companionBridgeRoutingSelection}
                        openSelector={companionOpenComposerSelector}
                        onToggleSelector={toggleCompanionComposerSelector}
                        onSelectValue={(_scope, type, value) => {
                          if (type === 'model') {
                            updateCompanionBridgeAgentRouting({
                              defaultModel: value,
                              defaultAuthProvider: selectedCompanionBridgeRoutingAgent.defaultAuthProvider ?? null,
                              defaultAuthChoice: selectedCompanionBridgeRoutingAgent.defaultAuthChoice ?? null,
                              fallbackModel: selectedCompanionBridgeRoutingAgent.fallbackModel ?? null,
                              fallbackAuthProvider: selectedCompanionBridgeRoutingAgent.fallbackAuthProvider ?? null,
                              fallbackAuthChoice: selectedCompanionBridgeRoutingAgent.fallbackAuthChoice ?? null,
                              thinking: companionDefaultThinkingForBridgeModel(value, selectedCompanionBridgeRoutingAgent.thinking),
                              selectorType: 'model',
                            });
                          } else if (type === 'thinking') {
                            updateCompanionBridgeAgentRouting({
                              defaultModel: selectedCompanionBridgeRoutingAgent.defaultModel ?? null,
                              defaultAuthProvider: selectedCompanionBridgeRoutingAgent.defaultAuthProvider ?? null,
                              defaultAuthChoice: selectedCompanionBridgeRoutingAgent.defaultAuthChoice ?? null,
                              fallbackModel: selectedCompanionBridgeRoutingAgent.fallbackModel ?? null,
                              fallbackAuthProvider: selectedCompanionBridgeRoutingAgent.fallbackAuthProvider ?? null,
                              fallbackAuthChoice: selectedCompanionBridgeRoutingAgent.fallbackAuthChoice ?? null,
                              thinking: value,
                              selectorType: 'thinking',
                            });
                          }
                        }}
                        authLabel={composerAuthLabel}
                        authOptions={composerAuthOptions}
                        onSelectAuthChoice={() => {}}
                        onSelectProviderChoice={(_scope, option) => {
                          const nextModel = firstModelForProvider(option.providerId, chatModelOptions);
                          if (!nextModel) return;
                          updateCompanionBridgeAgentRouting({
                            defaultModel: nextModel,
                            defaultAuthProvider: option.providerId,
                            defaultAuthChoice: authChoiceFromProviderOption(option),
                            fallbackModel: selectedCompanionBridgeRoutingAgent.fallbackModel ?? null,
                            fallbackAuthProvider: selectedCompanionBridgeRoutingAgent.fallbackAuthProvider ?? null,
                            fallbackAuthChoice: selectedCompanionBridgeRoutingAgent.fallbackAuthChoice ?? null,
                            thinking: companionDefaultThinkingForBridgeModel(nextModel, selectedCompanionBridgeRoutingAgent.thinking),
                            selectorType: 'provider',
                          });
                        }}
                        providerOptions={composerProviderOptions}
                        modelOptions={chatModelOptions && chatModelOptions.length > 0 ? chatModelOptions : undefined}
                        compact={true}
                      />
                    </div>
                  ) : null}
                  <Button
                    type="button"
                    size="icon"
                    variant="secondary"
                    onClick={() => sendCompanionDraft(companionConversation)}
                    className="app-composer-send h-10 w-10 shrink-0 rounded-full p-0"
                    title={`Send to ${companionConversation.name}`}
                    aria-label={`Send to ${companionConversation.name}`}
                    disabled={!companionDraftText.trim() && chatComposerAttachments.length === 0}
                    data-companion-send-control="true"
                  >
                    <Send className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
          </div>
          </ChatComposerShell>
        )}
      />
    </aside>
  ) : null;
  const splitDivider = showCompanionPane && companionConversation ? (
    <div
      className="app-chat-split-divider group relative z-10 flex h-full w-2.5 cursor-col-resize touch-none items-center justify-center bg-transparent transition hover:bg-white/[0.035]"
      data-split-layout-divider="true"
      onPointerDown={handleSplitDividerPointerDown}
      onPointerMove={handleSplitDividerPointerMove}
      onPointerUp={handleSplitDividerPointerUp}
      onPointerCancel={handleSplitDividerPointerUp}
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
  ) : null;
  const companionDetailTabs = useMemo<Array<{ id: DetailTab; label: string }>>(() => [
    { id: 'info', label: 'Info' },
    { id: 'artifacts', label: 'Artifacts' },
    { id: 'tasks', label: 'Tasks' },
  ], []);
  const companionArtifacts = useMemo(() => (
    companionConversation
      ? extractSessionArtifacts(companionConversation.messages, attributedCompanionTranscriptLiveTurn, companionConversation.reflectionLessonArtifacts)
      : []
  ), [attributedCompanionTranscriptLiveTurn, companionConversation]);
  const companionInlineDetailRail = showCompanionDetailRail && !isCompanionDetailPanelCollapsed && companionConversation ? (
    <div
      className="relative h-full min-h-0 min-w-0 overflow-hidden border-l border-white/[0.06] bg-white/[0.025]"
      style={{ width: detailRailWidth }}
      data-chat-companion-detail-rail="true"
    >
      <RightDetailRail
        detailTabs={companionDetailTabs}
        activeDetailTab={companionActiveDetailTab}
        onSelectDetailTab={(tab) => setCompanionActiveDetailTab(tab)}
        activeSourcePreview={null}
        onCloseSourcePreview={() => {}}
      >
        <ChatDetailPanel
          isNativeShell={isNativeShell}
          activeDetailTab={companionActiveDetailTab}
          activeConv={companionConversation}
          activeConvHasSubtitle={Boolean(formatSessionIdSubtitle(companionConversation.subtitle))}
          activeLastMessage={companionConversation.messages[companionConversation.messages.length - 1]}
          activeLiveTurn={attributedCompanionTranscriptLiveTurn?.sessionId === companionConversation.id || attributedCompanionTranscriptLiveTurn?.sessionId === companionConversation.canonicalSessionId ? attributedCompanionTranscriptLiveTurn : null}
          activeConversationIsBridge={false}
          activeBridgeConversationHostNodeId={null}
          activeBridgeConversationHostUrl={null}
          activeBridgeConversation={null}
          activeBridgeAwaitingReply={false}
          isBridgePolling={false}
          lastBridgePollAtLabel={null}
          activeSessionProject={null}
          artifacts={companionArtifacts}
          activeArtifactId={companionActiveArtifactId}
          onSelectArtifact={setCompanionActiveArtifactId}
          onOpenArtifact={(artifactId) => {
            setCompanionActiveArtifactId(artifactId);
            setCompanionActiveDetailTab('artifacts');
          }}
          onNavigateToResponse={handleNavigateToCompanionTranscriptMessage}
          onOpenOutreachThread={onSelectSession}
        />
      </RightDetailRail>
    </div>
  ) : null;
  const ownInlineDetailRail = showRightDetailRail && !isDetailPanelCollapsed && Boolean(rightDetailRail);
  const inlineDetailRail = ownInlineDetailRail ? (
    <div
      className="relative h-full min-h-0 min-w-0 overflow-hidden border-l border-white/[0.06] bg-white/[0.025]"
      style={{ width: detailRailWidth }}
      data-chat-inline-detail-rail="true"
    >
      {onDetailResizeMouseDown ? (
        <div
          onMouseDown={onDetailResizeMouseDown}
          className="absolute bottom-0 left-0 top-0 z-20 w-3 -translate-x-1/2 cursor-ew-resize"
          data-chat-inline-detail-resize="true"
          data-kordi-window-drag="false"
          aria-hidden="true"
        >
          <div className="mx-auto h-full w-px bg-white/8 transition hover:bg-white/20" />
        </div>
      ) : null}
      {rightDetailRail}
    </div>
  ) : null;
  useEffect(() => {
    if (!bridgeRoutingNotice) return;
    const timeoutId = window.setTimeout(() => {
      setBridgeRoutingNotice(null);
    }, BRIDGE_ROUTING_NOTICE_AUTO_DISMISS_MS);
    return () => window.clearTimeout(timeoutId);
  }, [bridgeRoutingNotice]);

  const closeBridgeRoutingSelector = (type: 'provider' | 'model' | 'thinking') => {
    if (openComposerSelector?.scope === 'chat' && openComposerSelector.type === type) {
      toggleComposerSelector('chat', type);
    }
  };

  const defaultThinkingForBridgeModel = (modelValue: string | null | undefined, currentThinking: string | null | undefined) => {
    const thinkingLevels = chatModelOptions?.find((option) => option.value === modelValue)?.thinkingLevels ?? [];
    return fallbackComposerThinkingValue(thinkingLevels, currentThinking ?? 'default');
  };

  const updateBridgeAgentRouting = ({
    defaultModel,
    defaultAuthProvider,
    defaultAuthChoice,
    fallbackModel,
    fallbackAuthProvider,
    fallbackAuthChoice,
    thinking,
    selectorType,
  }: {
    defaultModel?: string | null;
    defaultAuthProvider?: string | null;
    defaultAuthChoice?: string | null;
    fallbackModel?: string | null;
    fallbackAuthProvider?: string | null;
    fallbackAuthChoice?: string | null;
    thinking?: string | null;
    selectorType?: 'provider' | 'model' | 'thinking';
  }) => {
    if (selectorType) closeBridgeRoutingSelector(selectorType);
    focusComposerTextarea(CHAT_COMPOSER_TEXTAREA_SELECTOR);
    if (!selectedBridgeRoutingAgent || !selectedBridgeRoutingKey) return;
    if (isDesktopChatSending || activeLiveTurnIsRunning) {
      setBridgeRoutingNotice("Stop the running task before changing this session's model or thinking level.");
      return;
    }

    const currentModel = selectedBridgeRoutingAgent.defaultModel ?? null;
    const currentDefaultAuthProvider = selectedBridgeRoutingAgent.defaultAuthProvider ?? null;
    const currentDefaultAuthChoice = selectedBridgeRoutingAgent.defaultAuthChoice ?? null;
    const currentFallback = selectedBridgeRoutingAgent.fallbackModel ?? null;
    const currentFallbackAuthProvider = selectedBridgeRoutingAgent.fallbackAuthProvider ?? null;
    const currentFallbackAuthChoice = selectedBridgeRoutingAgent.fallbackAuthChoice ?? null;
    const currentThinking = selectedBridgeRoutingAgent.thinking ?? null;
    const nextModel = defaultModel !== undefined ? defaultModel : currentModel;
    const nextDefaultAuthProvider = defaultAuthProvider !== undefined ? defaultAuthProvider : currentDefaultAuthProvider;
    const nextDefaultAuthChoice = defaultAuthChoice !== undefined ? defaultAuthChoice : currentDefaultAuthChoice;
    const nextFallback = fallbackModel !== undefined ? fallbackModel : currentFallback;
    const nextFallbackAuthProvider = fallbackAuthProvider !== undefined ? fallbackAuthProvider : currentFallbackAuthProvider;
    const nextFallbackAuthChoice = fallbackAuthChoice !== undefined ? fallbackAuthChoice : currentFallbackAuthChoice;
    const nextThinking = thinking !== undefined ? thinking : currentThinking;
    const defaultAuthChanged = (defaultAuthProvider !== undefined && nextDefaultAuthProvider !== currentDefaultAuthProvider)
      || (defaultAuthChoice !== undefined && nextDefaultAuthChoice !== currentDefaultAuthChoice);
    const fallbackAuthChanged = (fallbackAuthProvider !== undefined && nextFallbackAuthProvider !== currentFallbackAuthProvider)
      || (fallbackAuthChoice !== undefined && nextFallbackAuthChoice !== currentFallbackAuthChoice);
    const noticeText = bridgeAgentRoutingChangeNotice({
      agentLabel: selectedBridgeRoutingAgent.label,
      currentModel,
      nextModel: defaultModel,
      currentThinking,
      nextThinking: thinking,
      modelLabel: bridgeRouteDisplayName(nextModel, nextDefaultAuthProvider, nextDefaultAuthChoice, chatModelOptions, composerProviderOptions),
      thinkingLabel: bridgeThinkingDisplayName(nextThinking),
    }) ?? ((defaultAuthChanged || fallbackAuthChanged)
      ? `${selectedBridgeRoutingAgent.label} model route changed to ${bridgeRouteDisplayName(nextModel, nextDefaultAuthProvider, nextDefaultAuthChoice, chatModelOptions, composerProviderOptions)}. Only you can see this.`
      : null);
    if (!noticeText) return;

    setOptimisticBridgeAgentRouting((current) => ({
      ...current,
      [selectedBridgeRoutingKey]: {
        defaultModel: nextModel,
        defaultAuthProvider: nextDefaultAuthProvider,
        defaultAuthChoice: nextDefaultAuthChoice,
        fallbackModel: nextFallback,
        fallbackAuthProvider: nextFallbackAuthProvider,
        fallbackAuthChoice: nextFallbackAuthChoice,
        thinking: nextThinking,
      },
    }));
    setBridgeRoutingNotice(noticeText);
    void onUpdateBridgeAgentModelRouting(
      selectedBridgeRoutingAgent.hostId,
      selectedBridgeRoutingAgent.id,
      nextModel,
      nextFallback,
      nextThinking,
      nextDefaultAuthProvider,
      nextDefaultAuthChoice,
      nextFallbackAuthProvider,
      nextFallbackAuthChoice,
    ).catch((error) => {
      setBridgeRoutingNotice(error instanceof Error ? error.message : 'Unable to update bridge agent model routing');
    });
  };

  const saveCompactModelRoute = (input: CompactComposerModelMenuSaveInput) => {
    if (activeConversationIsBridge && selectedBridgeRoutingAgent) {
      updateBridgeAgentRouting({
        defaultModel: input.model,
        defaultAuthProvider: input.providerOption?.providerId ?? selectedBridgeRoutingAgent.defaultAuthProvider ?? null,
        defaultAuthChoice: input.providerOption ? authChoiceFromProviderOption(input.providerOption) : selectedBridgeRoutingAgent.defaultAuthChoice ?? null,
        fallbackModel: selectedBridgeRoutingAgent.fallbackModel ?? null,
        fallbackAuthProvider: selectedBridgeRoutingAgent.fallbackAuthProvider ?? null,
        fallbackAuthChoice: selectedBridgeRoutingAgent.fallbackAuthChoice ?? null,
        thinking: input.thinking,
      });
      return;
    }

    void (async () => {
      if (input.providerOption) {
        await selectComposerProviderChoice('chat', input.providerOption);
      }
      if (input.model !== composerSelection.model) {
        await selectComposerValue('chat', 'model', input.model);
      }
      if (input.thinking !== composerSelection.thinking) {
        await selectComposerValue('chat', 'thinking', input.thinking);
      }
    })();
  };

  const chatSplitGridColumns = (() => {
    const ownDetailColumn = ownInlineDetailRail ? ` ${detailRailWidth}px` : '';
    const companionDetailColumn = companionInlineDetailRail ? ` ${detailRailWidth}px` : '';
    if (!showCompanionPane) return ownInlineDetailRail ? `minmax(0, 1fr)${ownDetailColumn}` : undefined;
    if (companionSide === 'left') {
      return `minmax(280px, ${splitLeftFraction}fr)${companionDetailColumn} 10px minmax(280px, ${1 - splitLeftFraction}fr)${ownDetailColumn}`;
    }
    return `minmax(280px, ${splitLeftFraction}fr)${ownDetailColumn} 10px minmax(280px, ${1 - splitLeftFraction}fr)${companionDetailColumn}`;
  })();

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <div
        ref={splitContainerRef}
        className={cn(
          'relative min-h-0 flex-1 overflow-hidden',
          chatSplitGridColumns && 'grid',
          isDraggingCompanion && 'ring-1 ring-sky-300/25',
          companionDropPreviewSide === 'left' && 'bg-gradient-to-r from-sky-400/10 via-transparent to-transparent',
          companionDropPreviewSide === 'right' && 'bg-gradient-to-l from-sky-400/10 via-transparent to-transparent',
        )}
        style={chatSplitGridColumns ? { gridTemplateColumns: chatSplitGridColumns } : undefined}
        data-chat-companion-side={showCompanionPane ? companionSide : 'folded'}
        data-chat-companion-drop-preview={companionDropPreviewSide ?? undefined}
        onDragOver={handleCompanionDragOver}
        onDrop={handleCompanionDrop}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setCompanionDropPreviewSide(null);
          }
        }}
      >
        {showCompanionPane && companionSide === 'left' ? companionPane : null}
        {showCompanionPane && companionSide === 'left' ? companionInlineDetailRail : null}
        {showCompanionPane && companionSide === 'left' ? splitDivider : null}
        <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-white/[0.025]" data-active-side={companionSide === 'left' ? 'right' : 'left'}>
      <div className="app-page-header flex min-h-[72px] shrink-0 items-center justify-between gap-3 border-b border-[color:var(--app-divider)] px-4 py-2.5 shadow-[0_1px_0_color-mix(in_srgb,var(--app-text)_8%,transparent)]">
        <div className="flex min-w-0 items-center gap-2">
          {showChatDetailRail && (
            <button
              type="button"
              onClick={() => setIsSessionPanelCollapsed((collapsed) => !collapsed)}
              className="app-icon-button app-utility-button grid h-7.5 w-7.5 shrink-0 place-items-center rounded-[12px] transition"
              aria-label={collapseChatSessions ? 'Open sessions' : 'Close sessions'}
              title={collapseChatSessions ? 'Open sessions' : 'Close sessions'}
            >
              {collapseChatSessions ? <PanelLeftOpen className="h-3.5 w-3.5" /> : <PanelLeftClose className="h-3.5 w-3.5" />}
            </button>
          )}
          <div className="min-w-0 flex-1">
            <div className="app-page-header-title-row mb-1 flex min-w-0 items-center gap-1.5 text-white">
              {isNativeShell ? (
                isEditingDesktopSessionTitle ? (
                  <input
                    value={desktopSessionRenameDraft}
                    onChange={(event) => setDesktopSessionRenameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        event.currentTarget.blur();
                      }
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        setDesktopSessionRenameDraft(activeConv.name);
                        setIsEditingDesktopSessionTitle(false);
                      }
                    }}
                    onBlur={() => {
                      void onRenameDesktopSession(activeConv.name);
                    }}
                    autoFocus
                    data-kordi-window-drag="false"
                    className="min-w-[220px] max-w-full rounded-lg bg-transparent px-1 py-0.5 text-left text-[17px] font-semibold text-white outline-none ring-1 ring-white/10 placeholder:text-slate-500 focus:ring-white/20"
                    placeholder="Session name"
                  />
                ) : (
                  <h2
                    onDoubleClick={() => {
                      if (activeConversationIsBridge) return;
                      setDesktopSessionRenameDraft(activeConv.name);
                      setIsEditingDesktopSessionTitle(true);
                    }}
                    className="min-w-0 max-w-[18rem] truncate rounded-lg px-1 py-0.5 text-left text-[17px] font-semibold leading-6 text-white transition hover:bg-white/5"
                    data-kordi-window-drag="false"
                    title={activeConv.name}
                  >
                    {activeConv.name}
                  </h2>
                )
              ) : (
                <h2 className="min-w-0 max-w-[18rem] truncate text-[17px] font-semibold leading-6" data-kordi-window-drag="false">{activeConv.name}</h2>
              )}
              {activeCloudSelfAgentSyncLabel ? (
                <span
                  className={cn(
                    'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md transition-colors',
                    cloudSelfAgentSyncStatus?.state === 'error'
                      ? 'text-rose-300'
                      : cloudSelfAgentSyncStatus?.state === 'syncing'
                        ? 'text-sky-200'
                        : 'text-emerald-200',
                  )}
                  title={cloudSelfAgentSyncStatus?.state === 'error'
                    ? cloudSelfAgentSyncStatus.message || 'Cloud sync needs attention'
                    : activeCloudSelfAgentSyncLabel}
                  aria-label={cloudSelfAgentSyncStatus?.state === 'error'
                    ? 'Cloud sync issue'
                    : activeCloudSelfAgentSyncLabel}
                  data-cloud-self-agent-sync-status={cloudSelfAgentSyncStatus?.state ?? 'idle'}
                >
                  <Cloud className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
              ) : null}
              {activeSessionSubtitle ? (
                <span data-chat-session-subtitle-pill="true" className="inline-flex h-5 shrink-0 items-center rounded-full border border-white/10 bg-white/[0.045] px-2 text-[10.5px] font-medium leading-none text-slate-300" title={activeSessionSubtitle}>{activeSessionSubtitle}</span>
              ) : null}
              {activeForkSourceSessionId ? (
                <button
                  type="button"
                  onClick={() => onSelectSession?.(activeForkSourceSessionId)}
                  disabled={!onSelectSession}
                  className="app-fork-source-pill inline-flex h-5 shrink-0 items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-2 text-[10.5px] font-medium text-slate-300 transition hover:bg-white/[0.08] hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                  title={`Forked from "${activeForkSourceTitle}" — open the source session`}
                  data-kordi-window-drag="false"
                >
                  <Split className="h-2.5 w-2.5" />
                  <span className="max-w-[12rem] truncate">Forked from {activeForkSourceTitle}</span>
                </button>
              ) : null}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {canOpenSideAgentPanel && !showCompanionPane ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => { void openSideAgentPanel(); }}
              className="app-utility-button mt-0.5 h-8 rounded-full px-3 text-[12px] font-medium transition"
              aria-label="Ask Agent"
              title={suggestedSideAgentConversation ? `Ask Agent with ${suggestedSideAgentConversation.name}` : 'Ask Agent in a new session'}
            >
              <Columns2 className="mr-1.5 h-3.5 w-3.5" />
              Ask Agent
            </Button>
          ) : null}
          {showRightDetailRail && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => setIsDetailPanelCollapsed((collapsed) => !collapsed)}
              className="app-utility-button mt-0.5 h-8 rounded-full px-3 text-[12px] font-medium transition"
              aria-label={isDetailPanelCollapsed ? 'Open session details' : 'Hide session details'}
              title={isDetailPanelCollapsed ? 'Open session details' : 'Hide session details'}
            >
              {isDetailPanelCollapsed ? 'Details' : 'Hide details'}
            </Button>
          )}
        </div>
      </div>

      {!hasAnyAuth && !activeConversationIsBridge ? (
        <AuthNoticeBanner
          title="No provider connected yet"
          description={authNoticeDescription}
          actionLabel={authNoticeActionLabel}
          onAction={onOpenAccountAuthentication ?? onOpenAuthSettings}
        />
      ) : null}

      {pinnedMessage ? (
        <PinnedMessageBar
          message={pinnedMessage}
          onOpenMessage={handleOpenPinnedMessage}
          onRequestUnpin={() => requestUnpinMessage(pinnedMessage)}
        />
      ) : null}

      <ChatSessionPane
        messages={attributedTranscriptMessages}
        liveTurn={attributedActiveTranscriptLiveTurn}
        liveTurnSender={liveTurnSender}
        shouldRenderLiveTurn={shouldRenderLiveTurn}
        scrollRef={chatTranscriptScrollRef}
        scrollClassName="min-h-0 flex-1 overflow-x-hidden overscroll-contain px-3.5 py-5 sm:px-4"
        densityMode={chatTranscriptDensityMode(activeConv)}
        onTranscriptScroll={onTranscriptScroll}
        queuedMessages={queuedDesktopMessages}
        onEditQueuedMessage={onEditQueuedMessage}
        onCancelQueuedMessage={onCancelQueuedMessage}
        isCompressionActive={isCompressionActive}
        plainAgentResponse={suppressAgentReplyAttribution}
        forkSnapshotBoundaryIndex={forkSnapshotBoundaryIndex}
        activeForkSourceSessionId={activeForkSourceSessionId}
        activeForkSourceTitle={activeForkSourceTitle}
        onSelectSession={onSelectSession}
        onOpenSource={onOpenSource}
        onOpenArtifact={onOpenArtifact}
        onOpenAuthSettings={openAuthentication}
        onNavigateToMessage={handleNavigateToTranscriptMessage}
        onOpenMessageDetail={onSelectMessage}
        onStopBridgeAgentRequest={onStopBridgeAgentRequest}
        onStopActiveTurn={onStopDesktopChatTurn}
        onRequestBridgeContact={onRequestBridgeContact}
        onForkMessage={handleForkMessage}
        messageForksByEntryId={messageForksByEntryId}
        onOpenForkSession={onSelectSession}
        onReplyMessage={onReplyMessage}
        onForwardMessage={onForwardMessage}
        onSelectMessage={onSelectMessage}
        onRequestPinMessage={requestPinMessage}
        onRequestUnpinMessage={requestUnpinMessage}
        pinnedMessageId={pinnedMessageId}
        selectionMode={messageSelectionMode}
        selectedMessageIds={selectedMessageIds}
        isMessageSelectable={isMessageSelectable}
        onToggleSelectedMessage={onToggleSelectedMessage}
        onSelectionDragStart={onSelectionDragStart}
        onSelectionDragEnter={onSelectionDragEnter}
        onSelectionDragEnd={onSelectionDragEnd}
        rightDetailRail={rightDetailRail}
        setIsDetailPanelCollapsed={setIsDetailPanelCollapsed}
        composer={(
          <ChatComposerShell
            chatComposerAttachments={chatComposerAttachments}
            saveDesktopAttachments={saveDesktopAttachments}
            saveDesktopAttachmentPaths={saveDesktopAttachmentPaths}
            removeChatComposerAttachment={removeChatComposerAttachment}
            activeChatQuote={activeChatQuote}
            onForwardMessage={onForwardMessage}
            onOpenMessageDetail={onSelectMessage}
            rightDetailRail={rightDetailRail}
            setIsDetailPanelCollapsed={setIsDetailPanelCollapsed}
          >
      <div className="shrink-0 px-5 pb-4 pt-3">
        {messageSelectionMode && selectedMessageCount > 0 ? (
          <div
            data-message-selection-bar="true"
            className="app-message-selection-bar mb-2 flex items-center justify-between gap-3 rounded-[22px] border border-[color:var(--app-control-border)] bg-[color:var(--app-modal-bg)] px-3.5 py-2.5 text-[color:var(--utility-foreground)] shadow-[var(--app-shadow-float)] backdrop-blur-[var(--app-glass-blur-float)]"
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
                disabled={!onForwardSelectedMessages || selectedMessageCount <= 0}
              >
                <Send className="h-3.5 w-3.5" aria-hidden="true" />
                Forward
              </button>
            </div>
          </div>
        ) : null}
        <AnimatePresence initial={false}>
          {activeConversationIsBridge && bridgeRoutingNotice ? (
            <motion.div
              key={bridgeRoutingNotice}
              className="mb-2 flex justify-center"
              role="status"
              aria-live="polite"
              initial={{ opacity: 0, y: prefersReducedMotion ? 0 : 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: prefersReducedMotion ? 0 : -4 }}
              transition={{ duration: prefersReducedMotion ? 0.01 : BRIDGE_ROUTING_NOTICE_EXIT_MS / 1000, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="max-w-[min(100%,38rem)] truncate rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-center text-[11px] text-slate-300">
                Private · {bridgeRoutingNotice}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
        <div className="app-composer-shell rounded-[26px] p-3">
          <div className="relative">
            {filteredChatSlashCommands.length > 0 ? (
              <ComposerSlashMenu
                items={filteredChatSlashCommands}
                selectedIndex={Math.min(chatSlashMenuIndex, filteredChatSlashCommands.length - 1)}
                onSelect={acceptChatSlashCommand}
              />
            ) : filteredChatMentionTargets.length > 0 ? (
              <ComposerMentionMenu
                items={filteredChatMentionTargets}
                selectedIndex={Math.min(chatSlashMenuIndex, filteredChatMentionTargets.length - 1)}
                onSelect={acceptChatMentionTarget}
              />
            ) : null}
            <div
              className={cn(
                'app-composer-input rounded-[18px] transition',
                chatComposerAttachments.length > 0 ? 'px-3 pb-1.5 pt-1' : 'px-4 py-2.5',
              )}
            >
              <input
                ref={chatAttachmentInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  if (files.length > 0) {
                    void saveDesktopAttachments(files);
                  }
                  event.currentTarget.value = '';
                }}
              />
              {activeChatQuote ? (
                <div
                  data-composer-quote-preview="true"
                  className="mb-1.5 flex items-start gap-2 rounded-[14px] border border-sky-300/20 bg-sky-400/10 px-2.5 py-2 text-left"
                >
                  <span className="mt-0.5 h-8 w-0.5 shrink-0 rounded-full bg-sky-300" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[11px] font-semibold text-sky-200">{activeChatQuote.source.senderLabel}</div>
                    <div className="truncate text-[11px] text-slate-300">
                      {activeChatQuote.source.textPreview || `${activeChatQuote.source.attachmentCount} attachment${activeChatQuote.source.attachmentCount === 1 ? '' : 's'}`}
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-label="Remove quoted message"
                    onClick={onClearChatQuote}
                    className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-slate-400 transition hover:bg-white/10 hover:text-white"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : null}
              {chatComposerAttachments.length > 0 ? (
                <div className="mb-1 flex flex-wrap items-center gap-1.5">
                  {chatComposerAttachments.map((attachment) => (
                    <div
                      key={attachment.id}
                      className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-[color:var(--app-divider)] bg-[color:var(--app-control-bg)] px-2.5 text-[11px] text-[color:var(--utility-foreground)]"
                    >
                      {attachment.kind === 'image' ? <ImageIcon className="h-3.5 w-3.5 shrink-0 text-sky-300" /> : <FileText className="h-3.5 w-3.5 shrink-0 text-slate-300" />}
                      <span className="max-w-[220px] truncate leading-none">{attachment.name}</span>
                      <button
                        type="button"
                        onClick={() => removeChatComposerAttachment(attachment.id)}
                        className="text-[color:var(--utility-muted-text)] transition hover:text-[color:var(--utility-foreground)]"
                        aria-label={`Remove ${attachment.name}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              <textarea
                rows={1}
                value={chatComposerText}
                onPointerDownCapture={() => focusComposerTextareaForNativeInput(CHAT_COMPOSER_TEXTAREA_SELECTOR, isNativeShell)}
                onFocus={() => focusComposerTextareaForNativeInput(CHAT_COMPOSER_TEXTAREA_SELECTOR, isNativeShell)}
                onChange={(event) => updateChatComposerDraft(event.target.value, event.target)}
                onPaste={(event) => {
                  const files = extractClipboardFiles(event.clipboardData);
                  if (files.length > 0) {
                    event.preventDefault();
                    void saveDesktopAttachments(files);
                    return;
                  }

                  const pastedPaths = extractPastedLocalFilePaths(
                    event.clipboardData.getData('text/plain'),
                    event.clipboardData.getData('text/uri-list'),
                  );
                  if (pastedPaths.length > 0) {
                    event.preventDefault();
                    void saveDesktopAttachmentPaths(pastedPaths);
                  }
                }}
                onCompositionStart={chatImeCompositionGuard.onCompositionStart}
                onCompositionEnd={chatImeCompositionGuard.onCompositionEnd}
                onKeyDown={(event) => {
                  if (chatImeCompositionGuard.isComposingKeyDown(event)) return;
                  if (filteredChatSlashCommands.length > 0) {
                    if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      setChatSlashMenuIndex((current) => (current + 1) % filteredChatSlashCommands.length);
                      return;
                    }
                    if (event.key === 'ArrowUp') {
                      event.preventDefault();
                      setChatSlashMenuIndex((current) => (current - 1 + filteredChatSlashCommands.length) % filteredChatSlashCommands.length);
                      return;
                    }
                    if ((event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.shiftKey) || event.key === 'Tab') {
                      event.preventDefault();
                      acceptChatSlashCommand(filteredChatSlashCommands[Math.min(chatSlashMenuIndex, filteredChatSlashCommands.length - 1)]?.value ?? filteredChatSlashCommands[0].value);
                      return;
                    }
                  }
                  if (filteredChatMentionTargets.length > 0) {
                    if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      event.stopPropagation();
                      setChatSlashMenuIndex((current) => (current + 1) % filteredChatMentionTargets.length);
                      return;
                    }
                    if (event.key === 'ArrowUp') {
                      event.preventDefault();
                      event.stopPropagation();
                      setChatSlashMenuIndex((current) => (current - 1 + filteredChatMentionTargets.length) % filteredChatMentionTargets.length);
                      return;
                    }
                    if (((event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.shiftKey) || event.key === 'Tab') && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      event.stopPropagation();
                      acceptChatMentionTarget(filteredChatMentionTargets[Math.min(chatSlashMenuIndex, filteredChatMentionTargets.length - 1)]?.value ?? filteredChatMentionTargets[0].value);
                      return;
                    }
                  }
                  if (event.key === 'Escape' && filteredChatSlashCommands.length > 0) {
                    event.preventDefault();
                    setChatComposerText('/');
                    return;
                  }
                  if (event.key === 'Escape' && filteredChatMentionTargets.length > 0) {
                    event.preventDefault();
                    setChatComposerText(chatComposerText.replace(/(^|\s)@([^\s@]*)$/, '$1'));
                    return;
                  }
                  if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
                    event.preventDefault();
                    handleSendChatMessage(event.currentTarget.value);
                  }
                }}
                className="min-h-[24px] max-h-[220px] w-full resize-none overflow-y-auto bg-transparent px-0 py-0 text-[15px] leading-6 text-[color:var(--utility-foreground)] outline-none placeholder:text-[color:var(--utility-muted-text)]"
                data-composer-scope="chat"
                placeholder={chatComposerPlaceholderText}
              />
            </div>
          </div>
          <div ref={composerControlsRef} className="app-composer-meta mt-2 flex items-center justify-between gap-4 pt-2.5">
            <div className="flex shrink-0 items-center gap-2 overflow-visible pr-1">
              {shouldUseCompactModelRouteMenu(activeConv) ? (
                <CompactComposerModelMenu
                  scope="chat"
                  selection={activeConversationIsBridge && selectedBridgeRoutingAgent ? bridgeRoutingSelection : composerSelection}
                  providerOptions={composerProviderOptions}
                  modelOptions={chatModelOptions && chatModelOptions.length > 0 ? chatModelOptions : undefined}
                  onSave={saveCompactModelRoute}
                />
              ) : null}
              <Button
                size="icon"
                variant="secondary"
                className="app-icon-button h-9 w-9 shrink-0 rounded-full border-0"
                onClick={() => chatAttachmentInputRef.current?.click()}
                title="Add attachment"
                aria-label="Add attachment"
              >
                <Paperclip className="h-4 w-4" />
              </Button>
            </div>
            <div className={cn('flex min-w-0 items-center overflow-visible', showCompanionPane ? 'shrink gap-2' : 'shrink-0 gap-3')}>
              {activePaneKind === 'agent' && !activeConversationIsBridge && (isNativeShell || activeRuntimeContextStatus) ? (
                <ComposerRuntimeStatus
                  contextStatus={activeRuntimeContextStatus}
                  cacheText={activeRuntimeCacheText}
                />
              ) : null}
              {activePaneKind === 'agent' && !activeConversationIsBridge && !shouldUseCompactModelRouteMenu(activeConv) ? (
                <ComposerModelControls
                  scope="chat"
                  selection={composerSelection}
                  openSelector={openComposerSelector}
                  onToggleSelector={toggleComposerSelector}
                  onSelectValue={(scope, type, value) => {
                    void selectComposerValue(scope, type, value);
                  }}
                  authLabel={composerAuthLabel}
                  authOptions={composerAuthOptions}
                  onSelectAuthChoice={(scope, providerId, choice) => {
                    void selectComposerAuthChoice(scope, providerId, choice);
                  }}
                  onSelectProviderChoice={(scope, option) => {
                    void selectComposerProviderChoice(scope, option);
                  }}
                  providerOptions={composerProviderOptions}
                  modelOptions={chatModelOptions && chatModelOptions.length > 0 ? chatModelOptions : undefined}
                  compact={showCompanionPane}
                />
              ) : activePaneKind === 'agent' && activeConversationIsBridge && !shouldUseCompactModelRouteMenu(activeConv) && selectedBridgeRoutingAgent ? (
                <div className="relative flex min-w-0 items-center gap-2 overflow-visible">
                  {bridgeRoutingControlVisibility.showAgentSelector ? (
                    <button
                      type="button"
                      onClick={() => toggleComposerSelector('chat', 'mode')}
                      className="inline-flex max-w-[10rem] items-center gap-1.5 rounded-full px-1 py-0.5 text-[12px] font-medium text-slate-300 transition hover:text-white"
                      title="Choose which owned agent these session settings apply to"
                    >
                      <span className="truncate">{selectedBridgeRoutingAgent.label}</span>
                      <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform', bridgeAgentSelectorOpen ? 'rotate-180 text-slate-300' : '')} />
                    </button>
                  ) : null}
                  {bridgeAgentSelectorOpen ? (
                    <div className="absolute bottom-full right-0 z-30 mb-2 max-h-[min(22rem,50vh)] w-[260px] overflow-y-auto rounded-[14px] border border-[color:var(--app-divider)] bg-[var(--app-modal-bg)] px-3 py-3 text-[12px] shadow-[var(--app-shadow-float)] backdrop-blur-xl">
                      <div className="pb-2 text-[12px] font-medium text-[color:var(--utility-foreground)]">My agent</div>
                      <div className="space-y-1">
                        {bridgeRoutingAgents.map((agent) => (
                          <button
                            key={`${agent.hostId}:${agent.id}`}
                            type="button"
                            onClick={() => {
                              setSelectedBridgeAgentId(agent.id);
                              toggleComposerSelector('chat', 'mode');
                            }}
                            className={cn(
                              'app-composer-popover-item flex w-full items-center justify-between px-3 py-2.5 text-left text-[13px]',
                              selectedBridgeRoutingAgent.id === agent.id ? 'app-composer-popover-item-active' : '',
                            )}
                          >
                            <span className="truncate">{agent.label}</span>
                            <span className="shrink-0 text-[11px] text-[color:var(--utility-muted-text)]">{agent.isDefault ? 'Default' : 'Owned'}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  <ComposerModelControls
                    scope="chat"
                    selection={bridgeRoutingSelection}
                    openSelector={openComposerSelector}
                    onToggleSelector={toggleComposerSelector}
                    onSelectValue={(_scope, type, value) => {
                      if (type === 'model') {
                        updateBridgeAgentRouting({
                          defaultModel: value,
                          defaultAuthProvider: selectedBridgeRoutingAgent.defaultAuthProvider ?? null,
                          defaultAuthChoice: selectedBridgeRoutingAgent.defaultAuthChoice ?? null,
                          fallbackModel: selectedBridgeRoutingAgent.fallbackModel ?? null,
                          fallbackAuthProvider: selectedBridgeRoutingAgent.fallbackAuthProvider ?? null,
                          fallbackAuthChoice: selectedBridgeRoutingAgent.fallbackAuthChoice ?? null,
                          thinking: defaultThinkingForBridgeModel(value, selectedBridgeRoutingAgent.thinking),
                          selectorType: 'model',
                        });
                      } else if (type === 'thinking') {
                        updateBridgeAgentRouting({
                          defaultModel: selectedBridgeRoutingAgent.defaultModel ?? null,
                          defaultAuthProvider: selectedBridgeRoutingAgent.defaultAuthProvider ?? null,
                          defaultAuthChoice: selectedBridgeRoutingAgent.defaultAuthChoice ?? null,
                          fallbackModel: selectedBridgeRoutingAgent.fallbackModel ?? null,
                          fallbackAuthProvider: selectedBridgeRoutingAgent.fallbackAuthProvider ?? null,
                          fallbackAuthChoice: selectedBridgeRoutingAgent.fallbackAuthChoice ?? null,
                          thinking: value,
                          selectorType: 'thinking',
                        });
                      }
                    }}
                    authLabel={composerAuthLabel}
                    authOptions={composerAuthOptions}
                    onSelectAuthChoice={() => {}}
                    onSelectProviderChoice={(_scope, option) => {
                      const nextModel = firstModelForProvider(option.providerId, chatModelOptions);
                      if (!nextModel) return;
                      updateBridgeAgentRouting({
                        defaultModel: nextModel,
                        defaultAuthProvider: option.providerId,
                        defaultAuthChoice: authChoiceFromProviderOption(option),
                        fallbackModel: selectedBridgeRoutingAgent.fallbackModel ?? null,
                        fallbackAuthProvider: selectedBridgeRoutingAgent.fallbackAuthProvider ?? null,
                        fallbackAuthChoice: selectedBridgeRoutingAgent.fallbackAuthChoice ?? null,
                        thinking: defaultThinkingForBridgeModel(nextModel, selectedBridgeRoutingAgent.thinking),
                        selectorType: 'provider',
                      });
                    }}
                    providerOptions={composerProviderOptions}
                    modelOptions={chatModelOptions && chatModelOptions.length > 0 ? chatModelOptions : undefined}
                    compact={showCompanionPane}
                  />
                </div>
              ) : null}
              <Button
                className="app-composer-send h-10 w-10 shrink-0 rounded-full p-0"
                onClick={() => handleSendChatMessage()}
                disabled={false}
                title={activeLiveTurnIsRunning ? 'Queue message for this session' : 'Send message'}
                aria-label="Send message"
              >
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>
          </ChatComposerShell>
        )}
      />
        </section>
        {inlineDetailRail}
        {pinDialog ? (
          <PinMessageDialog
            mode={pinDialog.mode}
            message={pinDialog.message}
            pinForEveryone={pinForEveryone}
            onTogglePinForEveryone={setPinForEveryone}
            onCancel={() => setPinDialog(null)}
            onConfirm={handleConfirmPinDialog}
          />
        ) : null}
        {showCompanionPane && companionSide === 'right' ? splitDivider : null}
        {showCompanionPane && companionSide === 'right' ? companionPane : null}
        {showCompanionPane && companionSide === 'right' ? companionInlineDetailRail : null}
      </div>
    </div>
  );
}
