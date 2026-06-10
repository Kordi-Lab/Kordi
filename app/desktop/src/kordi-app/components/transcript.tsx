import { memo, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowRightLeft,
  Bot,
  Check,
  CheckCheck,
  CheckCircle2,
  Copy,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock3,
  Forward,
  Split,
  LoaderCircle,
  Pencil,
  Pin,
  Reply,
  Sparkles,
  SquareArrowOutUpRight,
  Trash2,
  Undo2,
  User,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { messageDeliveryVisual } from '@/features/chat/deliveryStatus';
import { hasMessageSelectionDragExceededThreshold } from '@/features/chat/messageSelection';
import { MessageBubbleShapeBackdrop, humanMessageBubbleShapeClass } from '@/features/chat/messageBubbleShape';
import { selfDisplayName } from '@/lib/identityLabels';
import { cn } from '@/lib/utils';
import { IdentityAvatar, useLocalAgentAvatarSeed, useLocalProfileAvatarSeed, type IdentityAvatarKind } from './IdentityAvatar';
import { MarkdownContent } from './markdown';
import { AttachmentPreview } from './transcriptAttachments';
import { RequestReplyLine, SourceMessageQuote, transcriptMessageDomId } from './transcriptReplyAttribution';
import { LiveChatTurnCard, LiveChatTurnMessage, liveTurnSnapshotKey, type StopBridgeAgentRequestHandler } from './transcriptLiveTurns';
export { LiveChatTurnCard, LiveChatTurnMessage };
export { openInlineChangedFile } from './transcriptChangedFiles';
import type {
  Contact,
  ContactRequest,
  ConversationType,
  EditFilePreview,
  Message,
  MessageMention,
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

function ActiveSheenTitle({ text }: { text: string }) {
  return (
    <span className="app-transcript-sheen-title" aria-label={text}>
      {Array.from(text).map((character, index) => (
        <span
          key={`${character}-${index}`}
          aria-hidden="true"
          className="app-transcript-sheen-title-char"
          style={{ '--char-index': index } as CSSProperties}
        >
          {character === ' ' ? '\u00A0' : character}
        </span>
      ))}
    </span>
  );
}

function ForwardedFromHeader({ senderLabel }: { senderLabel?: string | null }) {
  const sender = senderLabel?.trim() || 'Unknown sender';

  return (
    <div
      data-message-forwarded-header="true"
      className="app-message-forwarded-header mb-1.5 flex min-w-0 items-center gap-1.5 text-[11px] font-medium leading-4"
    >
      <Forward className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="shrink-0">Forwarded from</span>
      <span className="app-message-forwarded-header-name min-w-0 truncate font-semibold">{sender}</span>
    </div>
  );
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

function senderAccentStyle(label?: string | null): CSSProperties {
  const text = label?.trim() || 'sender';
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  }
  const hue = Math.abs(hash) % 360;
  return { '--app-message-sender-accent': `oklch(0.72 0.15 ${hue})` } as CSSProperties;
}

function mentionPill(label: string, key: string) {
  return (
    <span key={key} className="app-message-mention">
      {label}
    </span>
  );
}

function isMentionBoundary(text: string, index: number, length: number) {
  const before = text[index - 1] ?? '';
  const after = text[index + length] ?? '';
  return (!before || /\s/.test(before)) && (!after || /[\s:;,.!?—-]/.test(after));
}

function renderTextWithMentionPills(text: string, mentions?: MessageMention[]) {
  const labels = (mentions ?? [])
    .map((mention) => mention.label.trim())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);

  if (labels.length > 0) {
    type Range = { start: number; end: number; label: string };
    const ranges: Range[] = [];

    const normalizedText = text.toLowerCase();
    labels.forEach((label) => {
      const needle = `@${label}`;
      const normalizedNeedle = needle.toLowerCase();
      let searchFrom = 0;
      while (searchFrom < text.length) {
        const start = normalizedText.indexOf(normalizedNeedle, searchFrom);
        if (start === -1) break;
        const end = start + needle.length;
        const overlaps = ranges.some((range) => start < range.end && end > range.start);
        if (!overlaps && isMentionBoundary(text, start, needle.length)) {
          ranges.push({ start, end, label: needle });
        }
        searchFrom = end;
      }
    });

    if (ranges.length > 0) {
      const ordered = ranges.sort((left, right) => left.start - right.start);
      const parts: ReactNode[] = [];
      let cursor = 0;
      ordered.forEach((range, index) => {
        if (range.start > cursor) parts.push(text.slice(cursor, range.start));
        parts.push(mentionPill(range.label, `${range.label}-${range.start}-${index}`));
        cursor = range.end;
      });
      if (cursor < text.length) parts.push(text.slice(cursor));
      return parts;
    }
  }

  const legacyParts = text.split(/(@[\p{L}\p{N}]{1,64})/gu);
  return legacyParts.map((part, index) => {
    if (!part.startsWith('@')) return part;
    return mentionPill(part, `${part}-${index}`);
  });
}

function MessageDeliveryClockGlyph({ className, active }: { className?: string; active: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className={cn(className, active && 'app-message-delivery-clock-active')}
      aria-hidden="true"
      focusable="false"
    >
      <circle className="app-message-delivery-clock-face" cx="8" cy="8" r="5.7" />
      <line className="app-message-delivery-clock-hour-hand" x1="8" y1="8" x2="8" y2="5.4" />
      <line className="app-message-delivery-clock-minute-hand" x1="8" y1="8" x2="8" y2="3.7" />
      <circle className="app-message-delivery-clock-pin" cx="8" cy="8" r="0.75" />
    </svg>
  );
}

function MessageDeliveryGlyph({ status }: { status?: string | null }) {
  const normalizedStatus = status?.trim().toLowerCase() || 'none';
  const visual = messageDeliveryVisual(status);
  const toneClass = visual?.tone === 'blue'
    ? 'text-sky-400'
    : visual?.tone === 'red'
      ? 'text-rose-400'
      : 'text-slate-400';
  const activeGlyph = visual?.glyph ?? 'none';
  const glyphClass = (glyph: NonNullable<ReturnType<typeof messageDeliveryVisual>>['glyph']) => cn(
    'absolute inset-0 h-3.5 w-3.5 transition-opacity duration-100',
    activeGlyph === glyph ? 'opacity-100' : 'opacity-0',
    toneClass,
  );

  return (
    <span
      className="relative inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center"
      data-message-delivery-status={normalizedStatus}
      data-message-delivery-glyph={activeGlyph}
      aria-label={visual?.label}
      role={visual ? 'img' : undefined}
      aria-hidden={visual ? undefined : true}
    >
      <Check className={glyphClass('single-check')} aria-hidden="true" />
      <CheckCheck className={glyphClass('double-check')} aria-hidden="true" />
      <MessageDeliveryClockGlyph className={glyphClass('clock')} active={Boolean(visual?.glyph === 'clock' && visual.motion === 'pulse')} />
      <LoaderCircle className={cn(glyphClass('spinner'), activeGlyph === 'spinner' && 'animate-spin')} aria-hidden="true" />
      <span className={cn(glyphClass('exclamation'), 'inline-flex items-center justify-center text-[13px] font-semibold leading-none')} aria-hidden="true">
        !
      </span>
    </span>
  );
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
  onRequestBridgeContact,
}: {
  detail?: string | null;
  onRequestBridgeContact: () => Promise<void> | void;
}) {
  const [state, setState] = useState<ContactRequestActionState>('idle');

  const handleRequestContact = async () => {
    if (state === 'sending' || state === 'sent') return;
    setState('sending');
    try {
      await onRequestBridgeContact();
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

function MessageDeliveryStatusSlot({ status }: { status?: string | null }) {
  return (
    <span
      className="inline-flex h-3.5 w-4 shrink-0 justify-center"
      data-message-delivery-status={status?.trim().toLowerCase() || 'none'}
      aria-live="off"
    >
      <MessageDeliveryGlyph status={status} />
    </span>
  );
}

function MessageFooter({
  time,
  status,
  detail,
  isUser,
  compact = false,
}: {
  time: string;
  status?: string | null;
  detail?: string;
  isUser?: boolean;
  compact?: boolean;
}) {
  const showDetail = detail && (!status || (status !== 'read' && status !== 'responded'));

  return (
    <div className={cn(
      'app-message-footer app-message-delivery-footer flex items-center gap-1.5 text-[10px] leading-none tabular-nums',
      compact ? 'shrink-0 self-end whitespace-nowrap pl-2 min-w-[4.6rem] justify-end' : 'ml-auto mt-1.5 min-w-[4.6rem] justify-end',
      isUser ? 'text-black/45' : 'text-slate-500/80',
    )}>
      {showDetail ? <span className="truncate text-[10px]">{detail}</span> : null}
      <span className="inline-block min-w-[2.5rem] text-right">{time}</span>
      <MessageDeliveryStatusSlot status={status} />
    </div>
  );
}

function messageReadReceiptCount(summary?: Message['readReceiptSummary'] | null) {
  return Math.max(0, Math.floor(summary?.count ?? 0));
}

const messageContextMenuTextStyle = {
  fontSize: '10px',
  fontWeight: 400,
  lineHeight: 1.45,
} satisfies CSSProperties;

function MessageContextMenuSeenRow({ summary }: { summary?: Message['readReceiptSummary'] | null }) {
  const count = messageReadReceiptCount(summary);
  if (count <= 0) return null;
  const participants = (summary?.participants ?? []).slice(0, 4);
  const names = participants.map((participant) => participant.name).filter(Boolean);
  const title = names.length > 0 ? `Seen by ${names.join(', ')}` : `${count} seen`;

  return (
    <div
      className="flex items-center gap-2 border-t border-slate-200 bg-slate-50 px-3 py-1.5 text-[10px] font-normal leading-[1.45] text-slate-950"
      data-message-context-menu-seen-row="true"
      title={title}
      style={messageContextMenuTextStyle}
    >
      <CheckCheck className="h-3.5 w-3.5 shrink-0 text-slate-700" aria-hidden="true" />
      <span>{count} Seen</span>
      {participants.length > 0 ? (
        <span className="ml-auto inline-flex -space-x-1" aria-hidden="true">
          {participants.map((participant) => (
            <IdentityAvatar
              key={participant.id}
              kind="human"
              seed={participant.avatarSeed ?? participant.id}
              name={participant.name}
              imageUrl={participant.profileImageUrl}
              className="h-4.5 w-4.5 border border-white"
            />
          ))}
        </span>
      ) : null}
    </div>
  );
}

function MessageContextMenuAction({ icon, label, action, onClick }: { icon: ReactNode; label: string; action: string; onClick?: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      data-message-context-menu-action={action}
      className="app-message-context-menu-action flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[10px] font-normal leading-[1.45] text-slate-950 transition hover:bg-slate-100"
      style={messageContextMenuTextStyle}
      onClick={onClick}
    >
      <span className="grid h-4 w-4 shrink-0 place-items-center text-slate-950" aria-hidden="true">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

export type MessageContextMenuActionHandlers = {
  onReplyMessage?: (message: Message) => void;
  onForwardMessage?: (message: Message) => void;
  onSelectMessage?: (message: Message) => void;
};

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

export function MessageContextMenuContent({
  msg,
  onClose,
  onReplyMessage,
  onForwardMessage,
  onSelectMessage,
}: {
  msg: Message;
  onClose?: () => void;
} & MessageContextMenuActionHandlers) {
  const copyableText = msg.text.trim() || msg.turn?.assistantText?.trim() || msg.detail?.trim() || '';
  const replyCount = msg.replySummary?.replyCount ?? 0;
  const reactionItems = ['❤️', '🔥', '👍', '👎', '🥰', '👏'];
  const copyText = async () => {
    if (!copyableText) return;
    try {
      await navigator.clipboard?.writeText(copyableText);
      onClose?.();
    } catch {
      onClose?.();
    }
  };
  const handleReply = () => {
    onReplyMessage?.(msg);
    onClose?.();
  };
  const handleForward = () => {
    onForwardMessage?.(msg);
    onClose?.();
  };
  const handleSelect = () => {
    onSelectMessage?.(msg);
    onClose?.();
  };

  return (
    <div className="app-message-context-menu-content w-[13.5rem] max-w-[calc(100vw-1rem)]" data-message-context-menu-content="true">
      <div className="app-message-context-menu-reactions mb-1.5 flex items-center gap-1 rounded-full bg-white px-2 py-1.5 shadow-[0_8px_24px_rgba(15,23,42,0.16)] ring-1 ring-slate-950/10" data-message-context-menu-reactions="true">
        {reactionItems.map((reaction) => (
          <button key={reaction} type="button" className="grid h-6 w-6 place-items-center rounded-full text-[14px] transition hover:bg-slate-100" aria-label={`React ${reaction}`}>
            {reaction}
          </button>
        ))}
        <button type="button" className="ml-auto grid h-6 w-6 place-items-center rounded-full bg-slate-100 text-[14px] text-slate-500" aria-label="More reactions">⌄</button>
      </div>
      <div className="overflow-hidden rounded-[14px] bg-white py-1 shadow-[0_14px_34px_rgba(15,23,42,0.18)] ring-1 ring-slate-950/10">
        <MessageContextMenuAction action="reply" icon={<Reply className="h-4 w-4" />} label="Reply" onClick={handleReply} />
        {replyCount > 0 ? <MessageContextMenuAction action="view-replies" icon={<Undo2 className="h-4 w-4" />} label={`View ${replyCount} Reply${replyCount === 1 ? '' : 'ies'}`} onClick={onClose} /> : null}
        <MessageContextMenuAction action="edit" icon={<Pencil className="h-4 w-4" />} label="Edit" onClick={onClose} />
        <MessageContextMenuAction action="pin" icon={<Pin className="h-4 w-4" />} label="Pin" onClick={onClose} />
        <MessageContextMenuAction action="copy-text" icon={<Copy className="h-4 w-4" />} label="Copy Text" onClick={copyText} />
        <MessageContextMenuAction action="forward" icon={<Forward className="h-4 w-4" />} label="Forward" onClick={handleForward} />
        <MessageContextMenuAction action="delete" icon={<Trash2 className="h-4 w-4" />} label="Delete" onClick={onClose} />
        <MessageContextMenuAction action="select" icon={<CheckCircle2 className="h-4 w-4" />} label="Select" onClick={handleSelect} />
        <MessageContextMenuSeenRow summary={msg.readReceiptSummary} />
      </div>
    </div>
  );
}

export function messageContextMenuPosition({
  clientX,
  clientY,
  targetRect,
  viewportWidth,
  viewportHeight,
  menuWidth = 216,
  menuHeight = 312,
}: {
  clientX: number;
  clientY: number;
  targetRect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>;
  viewportWidth: number;
  viewportHeight: number;
  menuWidth?: number;
  menuHeight?: number;
}) {
  const gap = 2;
  const aboveOverlap = 24;
  const anchorX = clientX <= (targetRect.left + targetRect.right) / 2
    ? targetRect.left
    : targetRect.right - menuWidth;
  const belowY = targetRect.bottom + gap;
  const aboveY = targetRect.top - menuHeight + aboveOverlap;
  const y = belowY + menuHeight <= viewportHeight - 8 ? belowY : aboveY;

  return {
    x: Math.max(8, Math.min(anchorX, viewportWidth - menuWidth - 8)),
    y: Math.max(8, Math.min(y, viewportHeight - menuHeight - 8)),
  };
}

function MessageContextMenuHost({
  msg,
  id,
  className,
  children,
  onPointerDown,
  onPointerEnter,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  dragSelectHandleId,
  dragSelectState,
  dragSelectLabel,
  onReplyMessage,
  onForwardMessage,
  onSelectMessage,
}: {
  msg: Message;
  id?: string;
  className?: string;
  children: ReactNode;
  onPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerEnter?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerCancel?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  dragSelectHandleId?: string;
  dragSelectState?: 'idle' | 'selected' | 'unselected';
  dragSelectLabel?: string;
} & MessageContextMenuActionHandlers) {
  const [messageContextMenu, setMessageContextMenu] = useState<{ x: number; y: number; clientX: number; clientY: number; targetRect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'> } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const openMessageContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const eventTarget = event.target instanceof Element ? event.target : null;
    const anchorElement = eventTarget?.closest('[data-message-context-menu-anchor="true"]') ?? null;
    const targetRect = (anchorElement ?? event.currentTarget).getBoundingClientRect();
    setMessageContextMenu({
      ...messageContextMenuPosition({
        clientX: event.clientX,
        clientY: event.clientY,
        targetRect,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      }),
      clientX: event.clientX,
      clientY: event.clientY,
      targetRect,
    });
  };
  useLayoutEffect(() => {
    if (!messageContextMenu || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const next = messageContextMenuPosition({
      clientX: messageContextMenu.clientX,
      clientY: messageContextMenu.clientY,
      targetRect: messageContextMenu.targetRect,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      menuWidth: rect.width,
      menuHeight: rect.height,
    });
    if (Math.abs(next.x - messageContextMenu.x) > 0.5 || Math.abs(next.y - messageContextMenu.y) > 0.5) {
      setMessageContextMenu({ ...messageContextMenu, ...next });
    }
  }, [messageContextMenu]);
  const menuLayer = messageContextMenu ? (
    <>
      <div
        className="fixed inset-0 z-[250]"
        onMouseDown={() => setMessageContextMenu(null)}
        onContextMenu={(event) => {
          event.preventDefault();
          setMessageContextMenu(null);
        }}
        aria-hidden="true"
      />
      <div
        ref={menuRef}
        className="app-message-context-menu fixed z-[260]"
        style={{ left: messageContextMenu.x, top: messageContextMenu.y }}
        role="menu"
        onMouseDown={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.preventDefault()}
      >
        <MessageContextMenuContent
          msg={msg}
          onClose={() => setMessageContextMenu(null)}
          onReplyMessage={onReplyMessage}
          onForwardMessage={onForwardMessage}
          onSelectMessage={onSelectMessage}
        />
      </div>
    </>
  ) : null;

  return (
    <div
      id={id}
      data-transcript-message-root="true"
      data-message-context-menu-target="true"
      data-message-selection-drag-handle={dragSelectHandleId}
      data-message-selection-drag-state={dragSelectState}
      aria-label={dragSelectLabel}
      onContextMenu={openMessageContextMenu}
      onPointerDown={onPointerDown}
      onPointerEnter={onPointerEnter}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      className={className}
    >
      {children}
      {menuLayer && typeof document !== 'undefined' ? createPortal(menuLayer, document.body) : menuLayer}
    </div>
  );
}

function CompactionSummaryMessage({ msg }: { msg: Message }) {
  const [expanded, setExpanded] = useState(false);
  const summary = useMemo(() => cleanCompactionSummary(msg.text), [msg.text]);
  const tokenLabel = compactionTokenLabel(msg.detail);
  const hasSummary = summary.trim().length > 0;

  return (
    <div className="flex w-full max-w-[min(100%,58rem)] flex-col items-start gap-0.5 py-1.5">
      <div className="app-message-meta">My Kordi • {msg.time}</div>
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
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[color:var(--app-divider)] px-2.5 py-1 text-[11px] font-medium text-[color:var(--utility-muted-text)] transition hover:border-[color:var(--utility-muted-text)] hover:text-[color:var(--utility-foreground)]"
              aria-expanded={expanded}
            >
              {expanded ? 'Hide summary' : 'Show summary'}
              {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
          ) : null}
        </div>
        {expanded && hasSummary ? (
          <div className="max-h-[26rem] overflow-y-auto border-t border-[color:var(--app-divider)] px-4 py-3 pr-5">
            <MarkdownContent text={summary} tone="muted" className="text-[13px]" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

export type MessageForkSummary = {
  sessionId: string;
  title: string;
  updatedAtLabel?: string;
};

function MessageBubbleView({
  msg,
  onOpenSource,
  onStopBridgeAgentRequest,
  onNavigateToMessage,
  onOpenArtifact,
  onOpenAuthSettings,
  onRequestBridgeContact,
  onForkMessage,
  messageForks,
  onOpenForkSession,
  onReplyMessage,
  onForwardMessage,
  onSelectMessage,
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
}: {
  msg: Message;
  onOpenSource?: (file: EditFilePreview) => void;
  onStopBridgeAgentRequest?: StopBridgeAgentRequestHandler;
  onNavigateToMessage?: (messageId: string, sourceMessage?: MessageSourceReference) => void;
  onOpenArtifact?: (artifactId: string) => void;
  onOpenAuthSettings?: () => void;
  onRequestBridgeContact?: () => Promise<void> | void;
  onForkMessage?: (entryId: string) => void;
  messageForks?: MessageForkSummary[];
  onOpenForkSession?: (sessionId: string) => void;
  onReplyMessage?: (message: Message) => void;
  onForwardMessage?: (message: Message) => void;
  onSelectMessage?: (message: Message) => void;
  plainAgentResponse?: boolean;
  isGroupedWithPrevious?: boolean;
  isGroupedWithNext?: boolean;
} & MessageSelectionProps) {
  const [isEditExpanded, setIsEditExpanded] = useState(true);
  const currentLocalProfileAvatarSeed = useLocalProfileAvatarSeed();
  const currentLocalAgentAvatarSeed = useLocalAgentAvatarSeed(msg.sender);
  const menuActionHandlers = { onReplyMessage, onForwardMessage, onSelectMessage };
  const selectionId = messageSelectionId(msg);
  const canDragSelectMessage = Boolean(selectionId && (isMessageSelectable?.(msg) ?? true));
  const selectableInSelectionMode = Boolean(selectionMode && canDragSelectMessage);
  const isSelectedForAction = Boolean(selectionId && selectedMessageIds?.has(selectionId));
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

  // Fork is offered on assistant turns only: clicking branches the
  // conversation into a new session that includes everything through
  // (and including) the clicked assistant response. The user can then
  // continue the conversation from there.
  const isAssistantRoleForFork = msg.role === 'owned-agent' || msg.role === 'external-agent';
  const canForkMessage = Boolean(onForkMessage && msg.entryId && isAssistantRoleForFork);
  const forkButton = canForkMessage ? (
    <button
      type="button"
      className="app-message-fork-button inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-slate-500 transition hover:bg-white/[0.06] hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20"
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
        className="app-message-fork-chip inline-flex h-6 items-center gap-1 rounded-full bg-white/[0.05] px-2 text-[10.5px] font-medium tabular-nums text-slate-300 transition hover:bg-white/[0.09] hover:text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20"
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
            className="app-message-fork-list absolute left-0 top-full z-50 mt-1 w-64 rounded-[14px] border border-white/10 bg-[color:var(--app-panel-bg)] p-1.5 shadow-[var(--app-shadow-float)]"
            role="menu"
          >
            {forks.map((fork) => (
              <button
                key={fork.sessionId}
                type="button"
                className="flex w-full items-baseline justify-between gap-2 rounded-[10px] px-2.5 py-1.5 text-left text-[12px] text-slate-100 transition hover:bg-white/[0.06] focus:outline-none focus-visible:bg-white/[0.06]"
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
                  <span className="shrink-0 text-[10px] tabular-nums text-slate-500">{fork.updatedAtLabel}</span>
                ) : null}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </span>
  ) : null;

  if (isCompactionSummaryMessage(msg)) {
    return (
      <MessageContextMenuHost msg={msg} {...menuActionHandlers}>
        <CompactionSummaryMessage msg={msg} />
      </MessageContextMenuHost>
    );
  }

  if (msg.role === 'system') {
    return (
      <MessageContextMenuHost msg={msg} {...menuActionHandlers} className="app-system-notice-row flex justify-center py-0.5">
        <div className="app-system-notice-pill max-w-[min(100%,34rem)] truncate rounded-full border bg-muted px-2.5 py-0.5 text-center text-[11px] leading-5 text-muted-foreground">{msg.text}</div>
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
        <div className="text-sm">{msg.text}</div>
        <div className="mt-2 text-xs text-muted-foreground">{msg.detail}</div>
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
            <div className="text-[14px] font-medium text-white/92">{msg.text}</div>
            <button className="inline-flex items-center gap-1.5 text-[12px] font-medium text-slate-400 transition hover:text-slate-200">
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
                <div className="app-code-panel px-0 py-2.5">
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
        className="flex w-full max-w-[min(100%,58rem)] flex-col items-start gap-0.5 py-0.5"
      >
        {msg.id && msg.turn.id && msg.id !== msg.turn.id ? (
          <span id={transcriptMessageDomId(msg.turn.id)} data-transcript-message-anchor="true" className="sr-only" aria-hidden="true" />
        ) : null}
        <div className="flex w-full items-center gap-1.5">
          <div className="app-message-meta">
            {msg.sender} • {msg.time}
          </div>
          {forkButton}
          {forkChip}
        </div>
        <LiveChatTurnCard
          turn={msg.turn}
          historical={msg.turn.completed}
          plainAgentResponse={plainAgentResponse}
          onStopBridgeAgentRequest={onStopBridgeAgentRequest}
          onNavigateToMessage={onNavigateToMessage}
          onOpenArtifact={onOpenArtifact}
          onOpenAuthSettings={onOpenAuthSettings}
        />
      </MessageContextMenuHost>
    );
  }

  const isOwnHumanMessage = (msg.isOwnMessage ?? (msg.role === 'user')) && (msg.senderType ?? 'human') === 'human';
  const isPeerHumanMessage = !isOwnHumanMessage && ((msg.senderType === 'human') || msg.role === 'person');
  const isAgentMessage = !isOwnHumanMessage && !isPeerHumanMessage;
  const align = isOwnHumanMessage ? 'items-end' : 'items-start';
  const bubble = isOwnHumanMessage
    ? 'app-chat-bubble-user'
    : isPeerHumanMessage
      ? 'app-chat-bubble-peer'
      : 'app-chat-bubble-agent';
  const deliveryStatus = primaryMessageStatus(msg);
  const deliveryVisual = deliveryStatus ? messageDeliveryVisual(deliveryStatus) : null;
  const showCompactFooter = isOwnHumanMessage || isPeerHumanMessage;
  const showHeaderMeta = Boolean(isAgentMessage && msg.sender);
  const hasText = msg.text.trim().length > 0;
  const hasAttachments = (msg.attachments?.length ?? 0) > 0;
  const hasOnlyImageAttachments = hasAttachments && !hasText && (msg.attachments ?? []).every((attachment) => attachment.kind === 'image');
  const showInlineCompactFooter = showCompactFooter && hasText && !hasAttachments;
  const avatarKind: IdentityAvatarKind = isAgentMessage ? 'agent' : 'human';
  const avatarName = selfDisplayName(msg.sender || (isOwnHumanMessage ? 'Me' : avatarKind === 'agent' ? 'Agent' : 'Person'), isOwnHumanMessage);
  const avatarSeed = isOwnHumanMessage
    ? currentLocalProfileAvatarSeed
    : msg.role === 'owned-agent'
      ? currentLocalAgentAvatarSeed
      : msg.senderAvatarSeed?.trim() || `${avatarKind}:${avatarName}`;
  const showInlineHumanSender = Boolean(!isAgentMessage && msg.showSenderMeta && msg.sender && !isGroupedWithPrevious);
  const showContactRequestAction = Boolean(
    isOwnHumanMessage
      && deliveryVisual?.tone === 'red'
      && onRequestBridgeContact
      && contactRequestFailureCanBeRetried(msg.detail),
  );
  const footerDetail = showContactRequestAction ? undefined : msg.detail;
  const showAvatarSlot = !isAgentMessage;
  const showAvatar = showAvatarSlot && !isGroupedWithNext;
  const isForwardedMessage = msg.messageAction?.kind === 'forward';
  const forwardedSource = isForwardedMessage ? msg.messageAction?.source : null;

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
        isGroupedWithPrevious ? 'pt-0.5' : 'pt-1',
        isGroupedWithNext ? 'pb-0' : 'pb-1',
        align,
        isAgentMessage ? 'w-full max-w-[min(100%,42rem)]' : '',
        showContactRequestAction ? 'w-full' : '',
        isSelectedForAction ? 'app-message-selection-selected' : '',
      )}
    >
      {showHeaderMeta ? (
        <div className="app-message-meta px-1">
          {isAgentMessage ? msg.sender : showCompactFooter ? msg.sender : `${msg.sender} • ${msg.time}`}
        </div>
      ) : null}
      <div className={cn('flex items-end', showAvatarSlot || selectionControl ? 'gap-2' : 'gap-0', isOwnHumanMessage ? 'flex-row-reverse' : 'flex-row', isAgentMessage ? 'w-full' : '')}>
        {selectionControl}
        {showAvatar ? (
          <IdentityAvatar
            kind={avatarKind}
            seed={avatarSeed}
            name={avatarName}
            imageUrl={msg.senderProfileImageUrl}
            className="mb-0.5 h-7 w-7 border border-white/10"
          />
        ) : showAvatarSlot ? (
          <span className="app-message-avatar-spacer h-7 w-7 shrink-0" aria-hidden="true" />
        ) : null}
        <div
          data-message-context-menu-anchor="true"
          onClick={(event) => {
            if (!selectableInSelectionMode) return;
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest('button,a,input,textarea,[role="button"]')) return;
            event.preventDefault();
            event.stopPropagation();
            onToggleSelectedMessage?.(msg);
          }}
          className={cn(
          'min-w-0',
          hasOnlyImageAttachments ? 'bg-transparent shadow-none' : 'shadow-sm',
          isOwnHumanMessage || isPeerHumanMessage ? 'text-[14px]' : 'text-[13px]',
          isOwnHumanMessage
            ? hasOnlyImageAttachments
              ? 'w-fit max-w-[31rem] p-0'
              : cn('w-fit min-w-[6.75rem] max-w-[34rem] px-4 py-2.5', humanMessageBubbleShapeClass('own'))
            : isPeerHumanMessage
              ? hasOnlyImageAttachments
                ? 'w-fit max-w-[31rem] p-0'
                : cn('w-fit min-w-[6.75rem] max-w-[34rem] px-4 py-2.5', humanMessageBubbleShapeClass('peer'))
              : 'w-fit max-w-full rounded-[20px] px-3.5 py-2.5',
          !hasOnlyImageAttachments && bubble,
        )}
        >
        {isOwnHumanMessage && !hasOnlyImageAttachments ? <MessageBubbleShapeBackdrop side="own" /> : null}
        {isPeerHumanMessage && !hasOnlyImageAttachments ? <MessageBubbleShapeBackdrop side="peer" /> : null}
        {showInlineHumanSender ? (
          <div
            className="app-message-inline-sender mb-1 truncate text-[12px] font-semibold leading-4"
            style={senderAccentStyle(msg.sender)}
          >
            {msg.sender}
          </div>
        ) : null}
        {forwardedSource ? <ForwardedFromHeader senderLabel={forwardedSource.senderLabel} /> : null}
        {msg.sourceMessage && !isForwardedMessage ? (
          <div className={cn(hasText || hasAttachments ? 'mb-2' : '')}>
            <SourceMessageQuote sourceMessage={msg.sourceMessage} onNavigateToMessage={onNavigateToMessage} />
          </div>
        ) : null}
        {showCompactFooter ? (
          showInlineCompactFooter ? (
            <div className="leading-[1.45]">
              <span className="whitespace-pre-wrap break-words">
                {renderTextWithMentionPills(msg.text, msg.mentions)}
              </span>
              <span className={cn(
                'app-message-footer app-message-compact-footer inline-flex translate-y-[1px] items-center whitespace-nowrap text-[9.5px] leading-none tabular-nums',
                isOwnHumanMessage ? 'app-message-delivery-footer ml-3 gap-0.5 text-black/45' : 'ml-4 gap-1 text-slate-500/80',
              )}>
                {!isOwnHumanMessage && footerDetail ? <span>{footerDetail}</span> : null}
                <span className={cn(isOwnHumanMessage && 'inline-block min-w-[2.1rem] text-right')}>{msg.time}</span>
                {isOwnHumanMessage ? <MessageDeliveryStatusSlot status={deliveryStatus} /> : null}
              </span>
            </div>
          ) : (
            <>
              <div className={cn('flex flex-col', hasAttachments && hasText ? 'gap-2.5' : 'gap-0')}>
                {hasAttachments ? <AttachmentPreview msg={msg} /> : null}
                {hasText ? <div className="whitespace-pre-wrap break-words">{renderTextWithMentionPills(msg.text, msg.mentions)}</div> : null}
              </div>
              {!hasOnlyImageAttachments ? (
                <MessageFooter
                  time={msg.time}
                  status={isOwnHumanMessage ? deliveryStatus : undefined}
                  detail={footerDetail}
                  isUser={isOwnHumanMessage}
                />
              ) : null}
            </>
          )
        ) : (
          <>
            <div className={cn('flex flex-col', hasAttachments && hasText ? 'gap-2.5' : 'gap-0')}>
              {hasAttachments ? <AttachmentPreview msg={msg} /> : null}
              {hasText ? <MarkdownContent text={msg.text} /> : null}
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
        </div>
        {forkButton}
        {forkChip}
      </div>
      {showContactRequestAction && onRequestBridgeContact ? (
        <div className="self-center">
          <ContactRequestFailureNotice detail={msg.detail} onRequestBridgeContact={onRequestBridgeContact} />
        </div>
      ) : null}
      {showCompactFooter ? (
        <RequestReplyLine
          summary={msg.replySummary}
          own={isOwnHumanMessage}
          onNavigateToMessage={onNavigateToMessage}
        />
      ) : null}
    </MessageContextMenuHost>
  );
}

function messageSnapshotKey(msg: Message) {
  return [
    msg.id ?? '',
    msg.entryId ?? '',
    msg.role,
    msg.sender ?? '',
    msg.senderType ?? '',
    msg.isOwnMessage ? 'own' : 'peer',
    msg.showSenderMeta ? 'meta' : '',
    msg.text,
    msg.time,
    msg.detail ?? '',
    msg.senderAvatarSeed ?? '',
    msg.senderProfileImageUrl ?? '',
    msg.statusChips?.join(',') ?? '',
    msg.replyToMessageId ?? '',
    msg.replyAliasIds?.join('|') ?? '',
    msg.replySummary ? [msg.replySummary.replyCount, msg.replySummary.pending ? 'pending' : 'done', msg.replySummary.targetMessageId ?? ''].join(':') : '',
    msg.readReceiptSummary ? [msg.readReceiptSummary.count, msg.readReceiptSummary.participants.map((participant) => [participant.id, participant.name, participant.readAt ?? ''].join(':')).join('|')].join(':') : '',
    msg.sourceMessage ? [msg.sourceMessage.messageId, msg.sourceMessage.text, msg.sourceMessage.senderLabel ?? ''].join(':') : '',
    msg.attachments?.map((attachment) => [attachment.kind, attachment.name, attachment.formatLabel ?? '', attachment.previewUrl ?? '', attachment.localPath ?? '', attachment.mimeType ?? ''].join(':')).join('|') ?? '',
    msg.mentions?.map((mention) => mention.label).join('|') ?? '',
    msg.turn ? liveTurnSnapshotKey(msg.turn) : '',
    msg.edit?.files.map((file) => [file.path, file.additions, file.deletions, file.lines.length].join(':')).join('|') ?? '',
  ].join('\u0001');
}

export const MessageBubble = memo(
  MessageBubbleView,
  (previous, next) => previous.onStopBridgeAgentRequest === next.onStopBridgeAgentRequest
    && previous.onNavigateToMessage === next.onNavigateToMessage
    && previous.onOpenArtifact === next.onOpenArtifact
    && previous.onOpenAuthSettings === next.onOpenAuthSettings
    && previous.onRequestBridgeContact === next.onRequestBridgeContact
    && previous.onForkMessage === next.onForkMessage
    && previous.onOpenForkSession === next.onOpenForkSession
    && previous.onReplyMessage === next.onReplyMessage
    && previous.onForwardMessage === next.onForwardMessage
    && previous.onSelectMessage === next.onSelectMessage
    && previous.selectionMode === next.selectionMode
    && previous.selectedMessageIds === next.selectedMessageIds
    && previous.isMessageSelectable === next.isMessageSelectable
    && previous.onToggleSelectedMessage === next.onToggleSelectedMessage
    && previous.onSelectionDragStart === next.onSelectionDragStart
    && previous.onSelectionDragEnter === next.onSelectionDragEnter
    && previous.onSelectionDragEnd === next.onSelectionDragEnd
    && previous.plainAgentResponse === next.plainAgentResponse
    && previous.messageForks === next.messageForks
    && previous.isGroupedWithPrevious === next.isGroupedWithPrevious
    && previous.isGroupedWithNext === next.isGroupedWithNext
    && (previous.msg === next.msg || messageSnapshotKey(previous.msg) === messageSnapshotKey(next.msg)),
);


export function BridgeChip({ bridge }: { bridge: string }) {
  return <Badge variant="outline" className="app-control-chip rounded-full">{bridge}</Badge>;
}

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
      className={`flex w-full items-center gap-3 rounded-[15px] px-3 py-2 text-left transition ${
        active ? 'app-list-item-active text-white' : 'app-list-item text-white'
      }`}
    >
      <IdentityAvatar
        kind={contactAvatarKind(contact)}
        seed={contact.avatarSeed ?? contact.bridgePeerNodeId ?? contact.id}
        name={contact.name}
        imageUrl={contact.profileImageUrl}
        className="h-10 w-10 border border-white/10"
        presenceStatus={contact.presenceStatus}
        presenceLabel={contact.presenceStatus ? `${contact.name} is ${contact.presenceStatus === 'online' ? 'online' : 'offline'}` : null}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium leading-5">{contact.name}</span>
          <span className={`text-[10.5px] leading-4 ${active ? 'text-slate-100' : 'text-slate-300'}`}>{contact.entityType}</span>
        </div>
        <div className={`truncate text-[11.5px] leading-4 ${active ? 'text-slate-100' : 'text-slate-300'}`}>{contact.subtitle}</div>
      </div>
      <ChevronRight className={`h-4 w-4 ${active ? 'text-slate-200' : 'text-slate-500'}`} />
    </button>
  );
}

export function ContactRequestRow({
  request,
  active,
  onReview,
  onAccept,
  onReject,
  actionState = null,
}: {
  request: ContactRequest;
  active: boolean;
  onReview: () => void;
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
        'rounded-2xl px-3 py-3 transition',
        active ? 'app-list-item-active text-white' : 'app-list-item bg-transparent text-white',
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
            <div className="shrink-0 text-[11px] text-slate-400">{request.time}</div>
          </div>
          <div className={`mt-1 text-xs ${active ? 'text-slate-100' : 'text-slate-300'}`}>{request.detail}</div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="secondary" className="h-8 rounded-xl px-3 text-[11px]" onClick={onReview} disabled={isBusy}>
              Review details
            </Button>
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
