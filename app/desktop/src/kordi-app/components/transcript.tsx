import { memo, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import {
  ArrowRightLeft,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock3,
  Split,
  LoaderCircle,
  Sparkles,
  SquareArrowOutUpRight,
  Undo2,
  User,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { messageDeliveryVisual, shouldAnimateHumanMessageEntry } from '@/features/chat/deliveryStatus';
import { attachmentsAreOnlyMp4Videos } from '@/features/chat/attachmentMediaGallery';
import { hasMessageSelectionDragExceededThreshold } from '@/features/chat/messageSelection';
import { humanMessageBubbleShapeClass } from '@/features/chat/messageBubbleShape';
import {
  relatedAgentSessionsFromTools,
  type RelatedAgentSessionRunStatus,
} from '@/features/chat/relatedAgentSessions';
import { transcriptMessageDomId } from '@/features/chat/transcriptNavigation';
import { selfDisplayName } from '@/lib/identityLabels';
import { cn } from '@/lib/utils';
import { IdentityAvatar, useLocalAgentAvatarSeed, useLocalProfileAvatarSeed, type IdentityAvatarKind } from './IdentityAvatar';
import { ForwardedFromHeader } from './forwardedFromHeader';
import { HumanMessageMarkdown } from './humanMessageMarkdown';
import { MarkdownContent } from './markdown';
import { MessageInlineContent } from './messageInlineContent';
import { MessageLinkPreview } from './messageLinkPreview';
import { firstExternalMessageLink } from './messageLinks';
import { messageBubblePropsEqual } from './messageBubbleMemo';
import { MessageReactionChips } from './messageReactions';
import { MessageContextMenuHost } from './messageContextMenuHost';
import { RelatedAgentSessionLinks } from './relatedAgentSessionLinks';
import { AttachmentPreview } from './transcriptAttachments';
import { SupportContactAnswer, SupportContactTypingIndicator } from './transcriptAssistantAnswer';
import { RequestReplyLine, SourceMessageQuote, ThreadReplyLine } from './transcriptReplyAttribution';
import { LiveChatTurnCard, LiveChatTurnMessage, type StopActiveTurnHandler, type StopCollaborationAgentRequestHandler } from './transcriptLiveTurns';
import { TranscriptCallActivityContent } from './transcriptCallActivityContent';
import { VoiceMessageContent } from './voiceMessage';
import { transcriptMessageIsOwnHuman, transcriptMessageIsPeerHuman } from './transcriptMessageHumanRole';
import { MessageDeliveryStatusSlot, TranscriptMessageTransferActions } from './transcriptMessageTransferActions';
import { TranscriptSystemNoticeContent } from './transcriptSystemNoticeContent';
import { ContactRequestTime, MessageEditedLabel, MessageHoverTime } from './transcriptMessageTime';
import type { MessageForkSummary } from './transcriptMessageForks';
import { TranscriptMessageSurface } from './transcriptMessageSurface';
import { AgentHeaderMeta, AgentOwnerTag } from './AgentOwnerTag';
export { LiveChatTurnCard, LiveChatTurnMessage };
export { MessageContextMenuContent } from './messageContextMenuContent';
export type { MessageContextMenuActionHandlers } from './messageContextMenuContent';
export { messageContextMenuPosition } from './messageContextMenuPosition';
export { openInlineChangedFile } from './transcriptChangedFiles';
import type {
  Contact,
  ContactRequest,
  ConversationType,
  EditFilePreview,
  Message, MessageAttachment,
  MessageSourceReference,
} from '../types';
const COMPACTION_DETAIL_PREFIX = 'Conversation compressed';
function isCompactionSummaryMessage(msg: Message) {
  return msg.role === 'system' && msg.detail?.startsWith(COMPACTION_DETAIL_PREFIX);
}
function cleanCompactionSummary(text: string) {
  const withoutResourceBlocks = text
    .replace(/\n?\s*<read-files>[\s\S]*?<\/read-files>\s*/gi, '\n')
    .replace(/\n?\s*<modified-files>[\s\S]*?<\/modified-files>\s*/gi, '\n')
    .replace(/\n?\s*<read-files>[\s\S]*$/gi, '')
    .replace(/\n?\s*<modified-files>[\s\S]*$/gi, '');

  return withoutResourceBlocks
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function compactionTokenLabel(detail?: string) {
  const match = detail?.match(/Conversation compressed\s*•\s*([^•]+?)\s+tokens before/i);
  return match?.[1]?.trim() ? `${match[1].trim()} tokens before` : null;
}
export function TypeBadge({ type, compact = false }: { type: ConversationType; compact?: boolean }) {
  const sizeClassName = compact
    ? 'gap-1 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[10px] leading-none [&_svg]:h-2.5 [&_svg]:w-2.5'
    : 'gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] leading-none';

  if (type === 'person') {
    return (
      <Badge variant="secondary" className={cn('app-badge-neutral', sizeClassName)}>
        <User className="h-3 w-3" />
        Human
      </Badge>
    );
  }
  if (type === 'owned-agent') {
    return (
      <Badge className={cn('app-badge-owned', sizeClassName)}>
        <Sparkles className="h-3 w-3" />
        My agent
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className={cn('app-badge-neutral', sizeClassName)}>
      <Bot className="h-3 w-3" />
      External agent
    </Badge>
  );
}

export function StatusPill({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('app-control-chip inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-1 text-[11px] font-medium leading-none [&_svg]:h-2.5 [&_svg]:w-2.5 [&_svg]:opacity-80', className)}>
      {children}
    </div>
  );
}
function primaryMessageStatus(msg: Message) {
  return msg.statusChips?.[0]?.trim().toLowerCase() ?? null;
}

function contactRequestFailureCanBeRetried(detail?: string | null) {
  const normalized = detail?.trim().toLowerCase() ?? '';
  return normalized.includes('contact request')
    && (
      normalized.includes('before messages')
      || normalized.includes('pending')
      || normalized.includes('rejected')
      || normalized.includes('blocked')
    );
}

type ContactRequestActionState = 'idle' | 'sending' | 'sent' | 'error';
function ContactRequestFailureNotice({
  detail,
  onRequestCollaborationContact,
}: {
  detail?: string | null;
  onRequestCollaborationContact: () => Promise<void> | void;
}) {
  const [state, setState] = useState<ContactRequestActionState>('idle');

  const handleRequestContact = async () => {
    if (state === 'sending' || state === 'sent') return;
    setState('sending');
    try {
      await onRequestCollaborationContact();
      setState('sent');
    } catch {
      setState('error');
    }
  };

  const buttonLabel = state === 'sending'
    ? 'Sending…'
    : state === 'sent'
      ? 'Request sent'
      : 'Send contact request';

  return (
    <div
      className="app-contact-request-failure-notice mt-1.5 inline-flex max-w-[min(100%,34rem)] items-center gap-2 rounded-full bg-white/[0.06] px-3 py-1.5 text-[11px] leading-none text-slate-300 shadow-sm"
      title={detail?.trim() || undefined}
    >
      <span>Message not delivered.</span>
      <button
        type="button"
        onClick={handleRequestContact}
        disabled={state === 'sending' || state === 'sent'}
        className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-semibold text-sky-200 transition hover:bg-white/15 hover:text-sky-100 disabled:cursor-default disabled:opacity-60"
      >
        {buttonLabel}
      </button>
      {state === 'error' ? (
        <span className="font-medium text-rose-300">Try again from Contacts.</span>
      ) : null}
    </div>
  );
}

function MessageFooter({
  message, status,
  detail,
  isUser,
  compact = false,
  replySummary,
  onNavigateToMessage,
}: {
  message: Message; status?: string | null;
  detail?: string;
  isUser?: boolean;
  compact?: boolean;
  replySummary?: Message['replySummary'];
  onNavigateToMessage?: (messageId: string) => void;
}) {
  const showDetail = detail && (!status || (status !== 'read' && status !== 'responded'));
  if (!isUser && !showDetail && !replySummary && !message.editedAt) return null;

  return (
    <div className={cn(
      'app-message-footer app-message-delivery-footer flex items-center text-[10px] leading-none tabular-nums',
      compact ? 'shrink-0 self-end whitespace-nowrap pl-2 justify-end' : 'ml-auto mt-1.5 justify-end',
      isUser ? 'gap-0.5 text-black/45' : 'gap-1.5 text-slate-500/80',
    )}>
      {showDetail ? <span className="truncate text-[10px]">{detail}</span> : null}<MessageEditedLabel msg={message} />
      <RequestReplyLine summary={replySummary} own={Boolean(isUser)} inline onNavigateToMessage={onNavigateToMessage} />
      {isUser ? <MessageDeliveryStatusSlot status={status} /> : null}
    </div>
  );
}

export type MessageSelectionProps = {
  selectionMode?: boolean;
  selectedMessageIds?: ReadonlySet<string>;
  isMessageSelectable?: (message: Message) => boolean;
  onToggleSelectedMessage?: (message: Message) => void;
  onSelectionDragStart?: (message: Message, shouldSelect: boolean) => void;
  onSelectionDragEnter?: (message: Message) => void;
  onSelectionDragEnd?: () => void;
};

function messageSelectionId(msg: Message) {
  return msg.id ?? msg.entryId ?? msg.turn?.id ?? '';
}

function CompactionSummaryMessage({ msg }: { msg: Message }) {
  const [expanded, setExpanded] = useState(false);
  const summary = useMemo(() => cleanCompactionSummary(msg.text), [msg.text]);
  const tokenLabel = compactionTokenLabel(msg.detail);
  const hasSummary = summary.trim().length > 0;

  return (
    <div className="flex w-full max-w-[min(100%,58rem)] flex-col items-start gap-0.5 py-1.5">
      <div className="app-message-meta">{msg.sender?.trim() || 'Kordi'} • {msg.time}</div>
      <div className="app-detail-sheet w-full">
        <div className="flex items-start gap-3 px-3.5 py-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-emerald-300/20 bg-emerald-400/10 text-emerald-200">
            <CheckCircle2 className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <div className="text-[13px] font-medium text-[color:var(--utility-foreground)]">Conversation compressed</div>
              {tokenLabel ? (
                <span className="rounded-full border border-[color:var(--app-divider)] bg-[color:var(--app-control-bg)] px-2 py-0.5 text-[10px] font-medium text-[color:var(--utility-muted-text)]">
                  {tokenLabel}
                </span>
              ) : null}
            </div>
            <div className="mt-1 text-[12px] leading-5 text-[color:var(--utility-muted-text)]">
              Older history is now a compact checkpoint. Recent messages stay available for the next response.
            </div>
          </div>
          {hasSummary ? (
            <button
              type="button"
              onClick={() => setExpanded((current) => !current)}
              className="app-button-quiet inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium"
              aria-expanded={expanded}
            >
              {expanded ? 'Hide summary' : 'Show summary'}
              {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
          ) : null}
        </div>
        {expanded && hasSummary ? (
          <div className="max-h-[26rem] overflow-y-auto border-t border-[color:var(--app-divider)] px-4 py-3 pr-5">
            <MarkdownContent text={summary} tone="muted" className="text-[13px]" showLinkIcons copySurface="message" />
          </div>
        ) : null}
      </div>
    </div>
  );
}
export type TranscriptDensityMode = 'default' | 'contact-compact' | 'group-compact' | 'agent-compact';
function MessageBubbleView({
  msg,
  onOpenSource,
  onStopCollaborationAgentRequest,
  onStopActiveTurn,
  onNavigateToMessage,
  onOpenArtifact,
  onOpenAuthSettings,
  onRequestCollaborationContact,
  onOpenSenderProfile,
  onForkMessage,
  messageForks,
  imageGallery,
  onOpenForkSession,
  relatedAgentSessionStatusById,
  onReplyMessage,
  onOpenMessageThread,
  onForwardMessage, onEditMessage, onDeleteMessage,
  onRetryMessage,
  onOpenMessageDetail,
  onSelectMessage,
  onRequestPinMessage,
  onRequestUnpinMessage,
  onReactMessage,
  pinnedMessageIds,
  selectionMode = false,
  selectedMessageIds,
  isMessageSelectable,
  onToggleSelectedMessage,
  onSelectionDragStart,
  onSelectionDragEnter,
  onSelectionDragEnd,
  plainAgentResponse = false,
  isGroupedWithPrevious = false,
  isGroupedWithNext = false,
  densityMode = 'default',
}: {
  msg: Message;
  onOpenSource?: (file: EditFilePreview) => void;
  onStopCollaborationAgentRequest?: StopCollaborationAgentRequestHandler;
  onStopActiveTurn?: StopActiveTurnHandler;
  onNavigateToMessage?: (messageId: string, sourceMessage?: MessageSourceReference) => void;
  onOpenArtifact?: (artifactId: string) => void;
  onOpenAuthSettings?: () => void;
  onRequestCollaborationContact?: () => Promise<void> | void;
  onOpenSenderProfile?: (message: Message, anchorRect: DOMRect) => void;
  onForkMessage?: (entryId: string) => void;
  messageForks?: MessageForkSummary[];
  imageGallery?: readonly MessageAttachment[];
  onOpenForkSession?: (sessionId: string) => void;
  relatedAgentSessionStatusById?: ReadonlyMap<string, RelatedAgentSessionRunStatus>;
  onReplyMessage?: (message: Message, destination: 'conversation' | 'thread') => void;
  onOpenMessageThread?: (message: Message) => void;
  onForwardMessage?: (message: Message) => void; onEditMessage?: (message: Message) => void; onDeleteMessage?: (message: Message) => void;
  onRetryMessage?: (message: Message) => Promise<void> | void;
  onOpenMessageDetail?: (message: Message) => void;
  onSelectMessage?: (message: Message) => void;
  onRequestPinMessage?: (message: Message) => void;
  onRequestUnpinMessage?: (message: Message) => void;
  onReactMessage?: (message: Message, reaction: string) => Promise<void> | void;
  pinnedMessageIds?: readonly string[];
  plainAgentResponse?: boolean;
  isGroupedWithPrevious?: boolean;
  isGroupedWithNext?: boolean;
  densityMode?: TranscriptDensityMode;
} & MessageSelectionProps) {
  const [isEditExpanded, setIsEditExpanded] = useState(true);
  const currentLocalProfileAvatarSeed = useLocalProfileAvatarSeed();
  const currentLocalAgentAvatarSeed = useLocalAgentAvatarSeed();
  const selectionId = messageSelectionId(msg);
  const isPinned = Boolean(selectionId && pinnedMessageIds?.includes(selectionId));
  const menuActionHandlers = { onReplyMessage, onOpenMessageThread, onForwardMessage, onEditMessage, onDeleteMessage, onOpenMessageDetail, onSelectMessage, onRequestPinMessage, onRequestUnpinMessage, onReactMessage, isPinned, imageGallery };
  const canDragSelectMessage = Boolean(selectionId && (isMessageSelectable?.(msg) ?? true));
  const selectableInSelectionMode = Boolean(selectionMode && canDragSelectMessage);
  const isSelectedForAction = Boolean(selectionId && selectedMessageIds?.has(selectionId));
  const agentOwnerName = msg.senderOwnerName?.trim() || (msg.role === 'owned-agent' ? 'You' : null);
  const selectionClickSuppressedRef = useRef(false);
  const rowSelectionDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    shouldSelect: boolean;
    started: boolean;
    cleanup: () => void;
  } | null>(null);
  const selectionLabel = `${isSelectedForAction ? 'Deselect' : 'Select'} message from ${msg.sender || 'Unknown sender'} at ${msg.time || 'unknown time'}`;
  const dragSelectLabel = canDragSelectMessage ? `Drag to select message from ${msg.sender || 'Unknown sender'} at ${msg.time || 'unknown time'}` : undefined;
  const dragSelectState = canDragSelectMessage ? (selectionMode ? (isSelectedForAction ? 'selected' : 'unselected') : 'idle') : undefined;
  const shouldIgnoreDragSelectTarget = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return false;
    return Boolean(target.closest('[data-message-context-menu-anchor="true"], [data-message-selection-control], button, a, input, textarea, select, [role="button"]'));
  };
  const handleRowSelectionDragStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !canDragSelectMessage) return;
    if (shouldIgnoreDragSelectTarget(event.target)) return;
    event.preventDefault();
    event.stopPropagation();

    rowSelectionDragRef.current?.cleanup();
    const pointerId = event.pointerId;
    const shouldSelect = selectionMode ? !isSelectedForAction : true;
    const startX = event.clientX;
    const startY = event.clientY;

    const cleanup = () => {
      const active = rowSelectionDragRef.current;
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerEnd);
      window.removeEventListener('pointercancel', handlePointerEnd);
      rowSelectionDragRef.current = null;
      if (active?.started) onSelectionDragEnd?.();
    };
    const handlePointerEnd = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return;
      cleanup();
    };
    const handlePointerMove = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return;
      const active = rowSelectionDragRef.current;
      if (!active || active.started) return;
      if (!hasMessageSelectionDragExceededThreshold(
        { x: active.startX, y: active.startY },
        { x: pointerEvent.clientX, y: pointerEvent.clientY },
      )) return;
      pointerEvent.preventDefault();
      window.getSelection()?.removeAllRanges();
      active.started = true;
      onSelectionDragStart?.(msg, active.shouldSelect);
    };

    rowSelectionDragRef.current = { pointerId, startX, startY, shouldSelect, started: false, cleanup };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerEnd);
    window.addEventListener('pointercancel', handlePointerEnd);
  };
  const handleRowSelectionDragEnter = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.buttons !== 1 || !canDragSelectMessage) return;
    onSelectionDragEnter?.(msg);
  };
  const handleRowSelectionDragMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.buttons !== 1 || !canDragSelectMessage) return;
    onSelectionDragEnter?.(msg);
  };
  const handleRowSelectionDragEnd = () => {
    if (rowSelectionDragRef.current) {
      rowSelectionDragRef.current.cleanup();
      return;
    }
    onSelectionDragEnd?.();
  };
  const selectionControl = selectableInSelectionMode ? (
    <button
      type="button"
      data-message-selection-control={selectionId}
      data-message-selection-draggable="true"
      data-message-selection-state={isSelectedForAction ? 'selected' : 'unselected'}
      aria-pressed={isSelectedForAction}
      aria-label={selectionLabel}
      className={cn(
        'app-message-selection-control grid h-5.5 w-5.5 shrink-0 place-items-center rounded-full border text-[color:var(--utility-foreground)] transition',
        isSelectedForAction
          ? 'border-[color:var(--app-sidebar-accent)] bg-[color:var(--app-sidebar-accent)] text-[color:var(--app-sidebar-accent-text)]'
          : 'border-[color:var(--app-control-border)] bg-[color:var(--app-control-bg)] hover:bg-[color:var(--app-control-hover)]',
      )}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        selectionClickSuppressedRef.current = true;
        const clearSuppression = () => {
          window.setTimeout(() => {
            selectionClickSuppressedRef.current = false;
          }, 0);
        };
        window.addEventListener('pointerup', clearSuppression, { once: true });
        window.addEventListener('pointercancel', clearSuppression, { once: true });
        onSelectionDragStart?.(msg, !isSelectedForAction);
      }}
      onPointerEnter={(event) => {
        if (event.buttons !== 1) return;
        onSelectionDragEnter?.(msg);
      }}
      onPointerUp={() => {
        onSelectionDragEnd?.();
      }}
      onPointerCancel={() => {
        onSelectionDragEnd?.();
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (selectionClickSuppressedRef.current) {
          selectionClickSuppressedRef.current = false;
          return;
        }
        onToggleSelectedMessage?.(msg);
      }}
    >
      {isSelectedForAction ? <Check className="h-3 w-3" aria-hidden="true" /> : null}
    </button>
  ) : null;

  // Fork is offered on assistant turns only. Reserve its header slot before the
  // canonical entry ID arrives so reconciliation cannot shift or remount it.
  const isAssistantRoleForFork = msg.role === 'owned-agent' || msg.role === 'external-agent';
  const canRenderForkControl = Boolean(onForkMessage && isAssistantRoleForFork);
  const forkButton = canRenderForkControl ? (
    <button
      type="button"
      className={cn('app-button-quiet app-message-fork-button inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md p-0', !msg.entryId && 'invisible pointer-events-none')}
      disabled={!msg.entryId}
      aria-hidden={!msg.entryId}
      tabIndex={msg.entryId ? undefined : -1}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (msg.entryId) onForkMessage?.(msg.entryId);
      }}
      title="Fork from here — new session continues this thread"
      aria-label="Fork this conversation from here"
    >
      <Split className="h-3.5 w-3.5" />
    </button>
  ) : null;

  const [isForkListOpen, setIsForkListOpen] = useState(false);
  const forks = messageForks ?? [];
  const forkCount = forks.length;
  const forkChip = forkCount > 0 ? (
    <span className="relative inline-flex">
      <button
        type="button"
        className="app-button-quiet app-message-fork-chip inline-flex h-6 items-center gap-1 rounded-full px-2 text-[10.5px] font-medium tabular-nums"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setIsForkListOpen((open) => !open);
        }}
        title={`${forkCount} fork${forkCount === 1 ? '' : 's'} of this message`}
        aria-haspopup="menu"
        aria-expanded={isForkListOpen}
      >
        <Split className="h-2.5 w-2.5" />
        <span>
          {forkCount} fork{forkCount === 1 ? '' : 's'}
        </span>
      </button>
      {isForkListOpen ? (
        <>
          <div
            className="fixed inset-0 z-40"
            onMouseDown={() => setIsForkListOpen(false)}
            aria-hidden="true"
          />
          <div
            className="app-transient-surface app-message-fork-list absolute left-0 top-full z-50 mt-1 w-64 rounded-[14px] border p-1.5"
            role="menu"
          >
            {forks.map((fork) => (
              <button
                key={fork.sessionId}
                type="button"
                className="app-transient-row flex w-full items-baseline justify-between gap-2 rounded-[10px] px-2.5 py-1.5 text-left text-[12px] transition focus:outline-none"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setIsForkListOpen(false);
                  onOpenForkSession?.(fork.sessionId);
                }}
                role="menuitem"
              >
                <span className="min-w-0 flex-1 truncate" title={fork.title}>{fork.title}</span>
                {fork.updatedAtLabel ? (
                  <span className="app-transient-muted shrink-0 text-[10px] tabular-nums">{fork.updatedAtLabel}</span>
                ) : null}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </span>
  ) : null;
  const relatedAgentSessions = relatedAgentSessionsFromTools(msg.turn?.tools);

  if (isCompactionSummaryMessage(msg)) {
    return (
      <MessageContextMenuHost msg={msg} {...menuActionHandlers}>
        <CompactionSummaryMessage msg={msg} />
      </MessageContextMenuHost>
    );
  }

  if (msg.role === 'system' || msg.callActivity) {
    return (
      <MessageContextMenuHost msg={msg} {...menuActionHandlers} className="app-system-notice-row flex justify-center py-0.5">
        <TranscriptSystemNoticeContent message={msg}><MessageInlineContent text={msg.text} /></TranscriptSystemNoticeContent>
      </MessageContextMenuHost>
    );
  }
  if (msg.role === 'action') {
    return (
      <MessageContextMenuHost msg={msg} {...menuActionHandlers} className="my-2 max-w-[42rem] rounded-2xl border bg-card p-4 shadow-sm">
        <div className="mb-2 flex items-center gap-2 text-sm font-medium">
          <ArrowRightLeft className="h-4 w-4" />
          {msg.sender}
        </div>
        <div className="text-sm" data-kordi-copy-surface="message"><MessageInlineContent text={msg.text} mentions={msg.mentions} /></div>
        <div className="mt-2 text-xs text-muted-foreground" data-kordi-copy-surface="message">{msg.detail}</div>
        <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Clock3 className="h-3 w-3" />
            {msg.time}
          </span>
          <span className="inline-flex items-center gap-1">
            <CheckCircle2 className="h-3 w-3" />
            Trace visible
          </span>
        </div>
      </MessageContextMenuHost>
    );
  }

  if (msg.role === 'edit' && msg.edit) {
    const primaryFile = msg.edit.files[0];

    return (
      <MessageContextMenuHost msg={msg} {...menuActionHandlers} className="flex flex-col items-start gap-0.5 py-0.5">
        <div className="app-message-meta">
          {msg.sender} • {msg.time}
        </div>
        <div className="app-detail-sheet w-full max-w-[760px]">
          <div className="flex items-center justify-between px-3.5 py-3">
            <div className="text-[14px] font-medium text-white/92" data-kordi-copy-surface="message"><MessageInlineContent text={msg.text} mentions={msg.mentions} /></div>
            <button className="app-button-quiet inline-flex items-center gap-1.5 rounded-[8px] px-2 py-1 text-[12px] font-medium">
              <Undo2 className="h-3.5 w-3.5" />
              Undo
            </button>
          </div>
          {primaryFile && (
            <>
              <div className="app-code-toolbar flex items-center justify-between border-t border-white/10 px-3.5 py-2">
                <div className="flex min-w-0 items-center gap-2.5 text-[12px]">
                  <span className="truncate font-medium text-white/88">{primaryFile.path}</span>
                  <span className="font-medium text-emerald-400">+{primaryFile.additions}</span>
                  <span className="font-medium text-rose-400">-{primaryFile.deletions}</span>
                </div>
                <div className="flex items-center gap-2 text-slate-400">
                  <button
                    type="button"
                    onClick={() => onOpenSource?.(primaryFile)}
                    className="app-icon-button grid h-6.5 w-6.5 place-items-center rounded-lg transition"
                    aria-label={`Open ${primaryFile.path}`}
                    title={`Open ${primaryFile.path}`}
                  >
                    <SquareArrowOutUpRight className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsEditExpanded((expanded) => !expanded)}
                    className="app-icon-button grid h-6.5 w-6.5 place-items-center rounded-lg transition"
                    aria-label={isEditExpanded ? 'Collapse diff preview' : 'Expand diff preview'}
                    title={isEditExpanded ? 'Collapse diff preview' : 'Expand diff preview'}
                  >
                    <ChevronUp className={cn('h-3.5 w-3.5 transition-transform', isEditExpanded ? '' : 'rotate-180')} />
                  </button>
                </div>
              </div>
              {isEditExpanded && (
                <div className="app-code-panel px-0 py-2.5" data-kordi-copy-surface="message">
                  <div className="font-mono text-[11px] leading-6">
                    {primaryFile.lines.map((line, index) => (
                      <div
                        key={`${line.kind}-${line.oldNumber ?? 'n'}-${line.newNumber ?? 'n'}-${index}`}
                        className={cn(
                          'grid grid-cols-[44px_44px_minmax(0,1fr)] items-start px-3.5',
                          line.kind === 'remove' ? 'bg-rose-400/12' : '',
                          line.kind === 'add' ? 'bg-emerald-400/12' : '',
                        )}
                      >
                        <div className={cn('select-none pr-3 text-right', line.kind === 'remove' ? 'text-rose-300' : 'text-slate-500')}>
                          {line.oldNumber ?? ''}
                        </div>
                        <div className={cn('select-none pr-3 text-right', line.kind === 'add' ? 'text-emerald-300' : 'text-slate-500')}>
                          {line.newNumber ?? ''}
                        </div>
                        <code
                          className={cn(
                            'block min-w-0 overflow-hidden text-ellipsis whitespace-pre-wrap break-words',
                            line.kind === 'remove' ? 'text-rose-100' : line.kind === 'add' ? 'text-emerald-100' : 'text-slate-200',
                          )}
                        >
                          {line.text}
                        </code>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
          {(msg.statusChips?.length || msg.detail) ? (
            <div className="border-t border-white/10 px-3.5 py-2 text-[11px] text-slate-400">
              {msg.statusChips?.length ? (
                <div className="app-message-status-list mb-2">
                  {msg.statusChips.map((chip) => (
                    <span key={chip} className="app-message-status-chip inline-flex items-center rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] text-slate-300">
                      {chip}
                    </span>
                  ))}
                </div>
              ) : null}
              {msg.detail ? <div>{msg.detail}</div> : null}
            </div>
          ) : null}
        </div>
      </MessageContextMenuHost>
    );
  }
  if (msg.turn) {
    return (
      <MessageContextMenuHost
        msg={msg}
        {...menuActionHandlers}
        id={msg.id || msg.turn.id ? transcriptMessageDomId(msg.id ?? msg.turn.id) : undefined}
        className="flex w-full max-w-[min(100%,61rem)] flex-col items-start py-0.5"
      >
        {msg.id && msg.turn.id && msg.id !== msg.turn.id ? (
          <span id={transcriptMessageDomId(msg.turn.id)} data-transcript-message-anchor="true" className="sr-only" aria-hidden="true" />
        ) : null}
        <div className="flex w-fit max-w-full items-end gap-2">
          <div className="app-message-hover-time-trigger min-w-0 w-fit max-w-[58rem]">
            <div className="flex w-full items-center gap-1.5">
              <div className="app-message-meta">
                {msg.sender}
              </div>
              <AgentOwnerTag name={agentOwnerName} />
              {forkButton}
              {forkChip}
            </div>
            <LiveChatTurnCard
              turn={msg.turn}
              historical={msg.turn.completed}
              plainAgentResponse={plainAgentResponse}
              onStopCollaborationAgentRequest={onStopCollaborationAgentRequest}
              onStopActiveTurn={onStopActiveTurn}
              onNavigateToMessage={onNavigateToMessage}
              onOpenArtifact={onOpenArtifact}
              onOpenAuthSettings={onOpenAuthSettings}
            />
            <RelatedAgentSessionLinks
              sessions={relatedAgentSessions}
              agentName={msg.sender}
              statusBySessionId={relatedAgentSessionStatusById}
              onOpen={onOpenForkSession}
            />
          </div>
          <MessageHoverTime msg={msg} side="peer" />
        </div>
      </MessageContextMenuHost>
    );
  }
  const isOwnHumanMessage = transcriptMessageIsOwnHuman(msg);
  const isPeerHumanMessage = transcriptMessageIsPeerHuman(msg, isOwnHumanMessage);
  const isAgentMessage = !isOwnHumanMessage && !isPeerHumanMessage;
  const compactDensity = densityMode !== 'default' && !isAgentMessage ? densityMode : undefined;
  const useHumanCompactDensity = Boolean(compactDensity);
  const hideHumanSenderForCompactDensity = useHumanCompactDensity && compactDensity !== 'group-compact';
  const align = isOwnHumanMessage ? 'items-end' : 'items-start';
  const bubble = isOwnHumanMessage
    ? 'app-chat-bubble-user'
    : isPeerHumanMessage
      ? 'app-chat-bubble-peer'
      : 'app-chat-bubble-agent';
  const deliveryStatus = primaryMessageStatus(msg);
  const deliveryVisual = deliveryStatus ? messageDeliveryVisual(deliveryStatus) : null;
  const showCompactFooter = isOwnHumanMessage || isPeerHumanMessage; const showHeaderMeta = Boolean(isAgentMessage && msg.sender);
  const hasVoice = Boolean(msg.voiceMessage); const hasText = Boolean(msg.callActivity) || (!hasVoice && msg.text.trim().length > 0); const hasLinkPreview = hasText && !msg.callActivity && Boolean(firstExternalMessageLink(msg.text));
  const hasAttachments = (msg.attachments?.length ?? 0) > 0; const hasOnlyImageAttachments = hasAttachments && !hasText && (msg.attachments ?? []).every((attachment) => attachment.kind === 'image'); const hasOnlyBorderlessMediaAttachments = hasOnlyImageAttachments || (!hasText && !hasVoice && attachmentsAreOnlyMp4Videos(msg.attachments)); const hasMixedImageAttachments = hasText && (msg.attachments ?? []).some((attachment) => attachment.kind === 'image');
  const hasGroupedImageAttachments = hasAttachments && (msg.attachments?.length ?? 0) > 1 && (msg.attachments ?? []).every((attachment) => attachment.kind === 'image'); const hasDetachedImageGroup = hasGroupedImageAttachments && hasText;
  const showsExternalRetry = isOwnHumanMessage && deliveryVisual?.tone === 'red' && Boolean(onRetryMessage); const bubbleDeliveryStatus = showsExternalRetry ? null : deliveryStatus;
  const showInlineCompactFooter = showCompactFooter && hasText && !hasAttachments && !msg.supportContactResponse && !hasLinkPreview && !(/\r?\n/.test(msg.text) || /^\s*(?:`{3,}|#{1,3}\s+|>|[-*+]\s+|\d+\.\s+)/.test(msg.text));
  const avatarKind: IdentityAvatarKind = isAgentMessage ? 'agent' : 'human';
  const avatarName = selfDisplayName(msg.sender || (isOwnHumanMessage ? 'Me' : avatarKind === 'agent' ? 'Agent' : 'Person'), isOwnHumanMessage);
  const avatarSeed = isOwnHumanMessage
    ? currentLocalProfileAvatarSeed
    : msg.role === 'owned-agent'
      ? currentLocalAgentAvatarSeed
      : msg.senderAvatarSeed?.trim() || `${avatarKind}:${avatarName}`;
  const showInlineHumanSender = Boolean(!hideHumanSenderForCompactDensity && !isAgentMessage && msg.showSenderMeta && msg.sender && !isGroupedWithPrevious);
  const showContactRequestAction = Boolean(
    isOwnHumanMessage
      && deliveryVisual?.tone === 'red'
      && onRequestCollaborationContact
      && contactRequestFailureCanBeRetried(msg.detail),
  );
  const footerDetail = showContactRequestAction ? undefined : msg.detail; const showAvatarSlot = !isAgentMessage; const showAvatar = showAvatarSlot && !isGroupedWithNext;
  const canOpenSenderProfile = Boolean(isPeerHumanMessage && onOpenSenderProfile && !selectionMode); const isForwardedMessage = msg.messageAction?.kind === 'forward'; const forwardedSource = isForwardedMessage ? msg.messageAction?.source : null;
  const messageSurfaceContent = (
    <>
      {showInlineHumanSender ? (
        <div className="app-message-inline-sender mb-1 truncate text-[12px] font-semibold leading-4">{msg.sender}</div>
      ) : null}
      {forwardedSource ? <ForwardedFromHeader senderLabel={forwardedSource.senderLabel} /> : null}
      {msg.sourceMessage && !isForwardedMessage ? (
        <div className={cn(hasText || hasAttachments || hasVoice ? 'mb-2' : '')}><SourceMessageQuote sourceMessage={msg.sourceMessage} compactReplyPreview={isOwnHumanMessage || isPeerHumanMessage} onNavigateToMessage={onNavigateToMessage} /></div>
      ) : null}
      {showCompactFooter ? (
        showInlineCompactFooter ? (
          <div className="leading-[1.45]">
            <span className="whitespace-pre-wrap break-words" data-kordi-copy-surface="message">
              {msg.callActivity ? <TranscriptCallActivityContent message={msg} /> : <HumanMessageMarkdown message={msg} inline onOpenSenderProfile={onOpenSenderProfile} />}
            </span>
            {isOwnHumanMessage || footerDetail || msg.replySummary || msg.editedAt ? (
              <span className={cn(
                'app-message-footer app-message-compact-footer inline-flex translate-y-[1px] items-center whitespace-nowrap text-[9.5px] leading-none tabular-nums',
                isOwnHumanMessage ? 'app-message-delivery-footer ml-3 gap-0.5 text-black/45' : 'ml-4 gap-1 text-slate-500/80',
              )}>
                {!isOwnHumanMessage && footerDetail ? <span>{footerDetail}</span> : null}<MessageEditedLabel msg={msg} />
                <RequestReplyLine summary={msg.replySummary} own={isOwnHumanMessage} inline onNavigateToMessage={onNavigateToMessage} />
                {isOwnHumanMessage ? <MessageDeliveryStatusSlot status={bubbleDeliveryStatus} /> : null}
              </span>
            ) : null}
          </div>
        ) : (
          <>
            <div className={cn('flex flex-col', hasAttachments && !hasDetachedImageGroup && hasText ? 'gap-2.5' : 'gap-0')}>
              {msg.voiceMessage ? <VoiceMessageContent voice={msg.voiceMessage} footer={<MessageFooter message={msg} status={isOwnHumanMessage ? bubbleDeliveryStatus : undefined} detail={footerDetail} isUser={isOwnHumanMessage} compact replySummary={msg.replySummary} onNavigateToMessage={onNavigateToMessage} />} /> : null}
              {hasAttachments && !hasDetachedImageGroup ? (
                <AttachmentPreview
                  msg={msg}
                  imageGallery={imageGallery}
                  imageDeliveryStatus={hasOnlyBorderlessMediaAttachments && isOwnHumanMessage ? bubbleDeliveryStatus : null}
                />
              ) : null}
              {msg.supportContactTyping ? (
                <SupportContactTypingIndicator />
              ) : hasText ? (
                msg.supportContactResponse
                  ? <SupportContactAnswer text={msg.text} />
                  : <>{msg.callActivity ? <TranscriptCallActivityContent message={msg} /> : <HumanMessageMarkdown message={msg} onOpenSenderProfile={onOpenSenderProfile} />}{hasLinkPreview ? <MessageLinkPreview text={msg.text} /> : null}</>
              ) : null}
            </div>
            {!hasOnlyBorderlessMediaAttachments && !hasVoice ? (
              <MessageFooter
                message={msg} status={isOwnHumanMessage ? bubbleDeliveryStatus : undefined}
                detail={footerDetail}
                isUser={isOwnHumanMessage}
                replySummary={msg.replySummary}
                onNavigateToMessage={onNavigateToMessage}
              />
            ) : null}
          </>
        )
      ) : (
        <>
          <div className={cn('flex flex-col', hasAttachments && !hasDetachedImageGroup && hasText ? 'gap-2.5' : 'gap-0')}>{msg.voiceMessage ? <VoiceMessageContent voice={msg.voiceMessage} /> : null}
            {hasAttachments && !hasDetachedImageGroup ? <AttachmentPreview msg={msg} imageGallery={imageGallery} imageDeliveryStatus={null} /> : null}
            {hasText ? (msg.callActivity ? <TranscriptCallActivityContent message={msg} /> : <><MarkdownContent text={msg.text} showLinkIcons copySurface="message" />{hasLinkPreview ? <MessageLinkPreview text={msg.text} /> : null}</>) : null}
          </div>
          {(msg.statusChips?.length || footerDetail) ? (
            <div className={cn('app-message-status-bar border-t border-white/10 pt-2 text-[11px] text-slate-300', hasAttachments || hasText ? 'mt-2' : '')}>
              {msg.statusChips?.map((chip) => (
                <span key={chip} className="app-message-status-chip inline-flex items-center rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] text-slate-300">
                  {chip}
                </span>
              ))}
              {footerDetail ? <span className="text-slate-400">{footerDetail}</span> : null}
            </div>
          ) : null}
        </>
      )}
    </>
  );
  return (
    <MessageContextMenuHost
      msg={msg}
      {...menuActionHandlers}
      id={msg.id ? transcriptMessageDomId(msg.id) : undefined}
      dragSelectHandleId={canDragSelectMessage ? selectionId : undefined}
      dragSelectState={dragSelectState}
      dragSelectLabel={dragSelectLabel}
      onPointerDown={handleRowSelectionDragStart}
      onPointerEnter={handleRowSelectionDragEnter}
      onPointerMove={handleRowSelectionDragMove}
      onPointerUp={handleRowSelectionDragEnd}
      onPointerCancel={handleRowSelectionDragEnd}
      className={cn(
        'flex w-full flex-col gap-1',
        useHumanCompactDensity ? 'pt-0.5' : (isGroupedWithPrevious ? 'pt-0.5' : 'pt-1'),
        useHumanCompactDensity ? (isGroupedWithNext ? 'pb-0' : 'pb-0.5') : (isGroupedWithNext ? 'pb-0' : 'pb-1'),
        useHumanCompactDensity ? 'app-message-row-contact-compact' : '',
        align,
        isAgentMessage ? 'w-full max-w-[min(100%,61rem)]' : '',
        showContactRequestAction ? 'w-full' : '',
        isSelectedForAction ? 'app-message-selection-selected' : '',
      )}
      data-transcript-density={compactDensity}
    >
      {showHeaderMeta ? <AgentHeaderMeta sender={msg.sender} ownerName={agentOwnerName} /> : null}
      <div className={cn(
        'flex w-full max-w-full',
        hasOnlyBorderlessMediaAttachments ? 'items-start' : 'items-end',
        isAgentMessage ? 'w-fit max-w-full gap-2' : showAvatarSlot || selectionControl ? (useHumanCompactDensity ? 'gap-1.5' : 'gap-2') : 'gap-0',
        isOwnHumanMessage ? 'flex-row-reverse' : 'flex-row',
      )}>
        {selectionControl}
        {showAvatar ? (
          canOpenSenderProfile ? (
            <button
              type="button"
              data-message-sender-profile="true"
              className="shrink-0 rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--app-sidebar-accent)]"
              aria-label={`Open ${avatarName} profile`}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onOpenSenderProfile?.(msg, event.currentTarget.getBoundingClientRect());
              }}
            >
              <IdentityAvatar
                kind={avatarKind}
                seed={avatarSeed} isSelf={isOwnHumanMessage}
                name={avatarName}
                imageUrl={msg.senderProfileImageUrl}
                className={cn(
                  'mb-0.5 border border-white/10 transition hover:ring-2 hover:ring-[color:var(--app-sidebar-accent)]/35',
                  useHumanCompactDensity ? 'h-7 w-7' : 'h-8 w-8',
                )}
              />
            </button>
          ) : (
            <IdentityAvatar
              kind={avatarKind}
              seed={avatarSeed} isSelf={isOwnHumanMessage}
              name={avatarName}
              imageUrl={msg.senderProfileImageUrl}
              className={cn(
                'mb-0.5 border border-white/10',
                useHumanCompactDensity ? 'h-7 w-7' : 'h-8 w-8',
              )}
            />
          )
        ) : showAvatarSlot ? (
          <span className={cn('app-message-avatar-spacer shrink-0', useHumanCompactDensity ? 'h-7 w-7' : 'h-8 w-8')} aria-hidden="true" />
        ) : null}
        <TranscriptMessageSurface data-message-context-menu-anchor="true"
          data-message-media-side={hasOnlyBorderlessMediaAttachments || hasDetachedImageGroup ? isOwnHumanMessage ? 'own' : isPeerHumanMessage ? 'peer' : undefined : undefined} data-message-mixed-images={hasMixedImageAttachments ? 'true' : undefined}
          data-message-detached-image-group={hasDetachedImageGroup ? 'true' : undefined}
          attachmentPreview={<AttachmentPreview msg={msg} imageGallery={imageGallery} imageDeliveryStatus={null} />} borderless={hasOnlyBorderlessMediaAttachments}
          bubbleClassName={bubble} compact={useHumanCompactDensity} detachedImageGroup={hasDetachedImageGroup}
          enter={shouldAnimateHumanMessageEntry(isOwnHumanMessage || isPeerHumanMessage, deliveryStatus)}
          side={isOwnHumanMessage ? 'own' : isPeerHumanMessage ? 'peer' : 'agent'}
          data-transcript-density={compactDensity}
          onClick={(event) => {
            if (!selectableInSelectionMode) return;
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest('button,a,input,textarea,[role="button"]')) return;
            event.preventDefault();
            event.stopPropagation();
            onToggleSelectedMessage?.(msg);
          }}
          className={cn(
          'app-message-hover-time-trigger min-w-0',
          hasDetachedImageGroup ? cn('flex flex-col gap-2', isOwnHumanMessage ? 'items-end' : 'items-start') : '',
          hasGroupedImageAttachments ? (isOwnHumanMessage ? 'mr-4' : isPeerHumanMessage ? 'ml-4' : '') : '',
          hasOnlyBorderlessMediaAttachments || hasDetachedImageGroup ? 'bg-transparent shadow-none' : cn('shadow-sm', shouldAnimateHumanMessageEntry(isOwnHumanMessage || isPeerHumanMessage, deliveryStatus) && 'app-message-bubble-enter'),
          isOwnHumanMessage || isPeerHumanMessage ? 'text-[14px]' : 'text-[13px]',
          isOwnHumanMessage
            ? hasOnlyBorderlessMediaAttachments || hasDetachedImageGroup
              ? 'w-fit max-w-[31rem] p-0'
              : useHumanCompactDensity
                ? cn('app-message-bubble-contact-compact w-fit rounded-[8px] px-3 py-1.5', hasMixedImageAttachments ? 'max-w-[31rem]' : 'max-w-[52rem]', humanMessageBubbleShapeClass('own'))
                : cn('w-fit px-4 py-2.5', hasMixedImageAttachments ? 'max-w-[31rem]' : 'max-w-[52rem]', humanMessageBubbleShapeClass('own'))
            : isPeerHumanMessage
              ? hasOnlyBorderlessMediaAttachments || hasDetachedImageGroup
                ? 'w-fit max-w-[31rem] p-0'
                : useHumanCompactDensity
                  ? cn(
                    'app-message-bubble-contact-compact w-fit rounded-[8px] px-3 py-1.5', hasMixedImageAttachments ? 'max-w-[31rem]' : 'max-w-[52rem]',
                    msg.supportContactTyping ? 'min-w-[3.25rem]' : undefined,
                    humanMessageBubbleShapeClass('peer'),
                  )
                  : cn(
                    'w-fit px-4 py-2.5', hasMixedImageAttachments ? 'max-w-[31rem]' : 'max-w-[52rem]',
                    msg.supportContactTyping ? 'min-w-[4rem]' : undefined,
                    humanMessageBubbleShapeClass('peer'),
                  )
               : hasDetachedImageGroup ? 'w-fit max-w-[31rem] p-0' : 'w-fit max-w-[58rem] rounded-[20px] px-3.5 py-2.5', hasVoice && !hasOnlyBorderlessMediaAttachments ? 'px-2.5 py-1.5' : '',
          !hasOnlyBorderlessMediaAttachments && !hasDetachedImageGroup && bubble,
        )}
        >
        {messageSurfaceContent}
        </TranscriptMessageSurface>
        <TranscriptMessageTransferActions message={msg} showUploads={isOwnHumanMessage} retryable={showsExternalRetry} onRetryMessage={onRetryMessage} />
        <MessageHoverTime msg={msg} side={isOwnHumanMessage ? 'own' : 'peer'} />
        {forkButton}
        {forkChip}
      </div>
      <MessageReactionChips
        msg={msg}
        onReactMessage={onReactMessage}
        side={isOwnHumanMessage ? 'own' : isPeerHumanMessage ? 'peer' : 'standalone'}
      />
      {msg.threadSummary?.replyCount ? (
        <div className={cn(
          'flex min-h-7 items-center',
          isOwnHumanMessage ? 'justify-end pr-10' : showAvatarSlot ? 'justify-start pl-10' : 'justify-start',
        )}>
          <ThreadReplyLine
            count={msg.threadSummary.replyCount}
            own={isOwnHumanMessage}
            onOpen={onOpenMessageThread ? () => onOpenMessageThread(msg) : undefined}
          />
        </div>
      ) : null}
      {showContactRequestAction && onRequestCollaborationContact ? (
        <div className="self-center">
          <ContactRequestFailureNotice detail={msg.detail} onRequestCollaborationContact={onRequestCollaborationContact} />
        </div>
      ) : null}
    </MessageContextMenuHost>
  );
}

export type MessageBubbleProps = Parameters<typeof MessageBubbleView>[0];
export const MessageBubble = memo(MessageBubbleView, messageBubblePropsEqual);
function contactAvatarKind(contact: Contact): IdentityAvatarKind {
  return contact.classType === 'my-agents' || contact.classType === 'other-users-agents' ? 'agent' : 'human';
}

function requestAvatarKind(request: ContactRequest): IdentityAvatarKind {
  return /agent/i.test(request.title) ? 'agent' : 'human';
}

export function ContactRow({ contact, active, onSelect }: { contact: Contact; active: boolean; onSelect: () => void }) {
  return (
    <button
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      className="app-contact-row app-list-item flex w-full items-center gap-3 rounded-[15px] px-3 py-2 text-left text-white transition-none"
    >
      <IdentityAvatar
        kind={contactAvatarKind(contact)}
        seed={contact.avatarSeed ?? contact.sourceParticipantId ?? contact.id}
        name={contact.name}
        imageUrl={contact.profileImageUrl}
        className="h-10 w-10 border border-white/10"
        presenceStatus={contact.presenceStatus}
        presenceLabel={contact.presenceStatus ? `${contact.name} is ${contact.presenceStatus === 'online' ? 'online' : 'offline'}` : null}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium leading-5">{contact.name}</span>
          <span className="text-[10.5px] leading-4 text-slate-300">{contact.entityType}</span>
        </div>
        <div className="truncate text-[11.5px] leading-4 text-slate-300">{contact.subtitle}</div>
      </div>
      <ChevronRight className="h-4 w-4 text-slate-500" />
    </button>
  );
}

export function ContactRequestRow({
  request,
  active,
  onAccept,
  onReject,
  actionState = null,
}: {
  request: ContactRequest;
  active: boolean;
  onAccept?: () => void;
  onReject?: () => void;
  actionState?: 'accepting' | 'rejecting' | null;
}) {
  const isBusy = Boolean(actionState);
  const statusText = actionState === 'accepting'
    ? 'Accepting and sending greeting…'
    : actionState === 'rejecting'
      ? 'Rejecting request…'
      : '';

  return (
    <div
      className={cn(
        'app-contact-request-item px-3 py-3 text-white transition-none',
        active && 'app-contact-request-item-active',
      )}
    >
      <div className="flex items-start gap-3">
        <IdentityAvatar
          kind={requestAvatarKind(request)}
          seed={request.avatarSeed ?? request.id}
          name={request.title}
          imageUrl={request.profileImageUrl}
          className="h-10 w-10 border border-white/10"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <div className="truncate text-sm font-medium">{request.title}</div>
            <ContactRequestTime value={request.time} />
          </div>
          <div className={`mt-1 text-xs ${active ? 'text-slate-100' : 'text-slate-300'}`}>{request.detail}</div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button className="h-8 rounded-xl px-3 text-[11px]" onClick={onAccept} disabled={!onAccept || isBusy}>
              {actionState === 'accepting' ? (
                <>
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                  Accepting…
                </>
              ) : 'Accept'}
            </Button>
            <Button variant="secondary" className="h-8 rounded-xl px-3 text-[11px]" onClick={onReject} disabled={!onReject || isBusy}>
              {actionState === 'rejecting' ? (
                <>
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                  Rejecting…
                </>
              ) : 'Reject'}
            </Button>
          </div>
          {statusText ? (
            <div className="mt-2 text-[11px] leading-4 text-slate-400" aria-live="polite">
              {statusText}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
