import { memo, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import {
  ArrowRightLeft,
  Bot,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock3,
  LoaderCircle,
  Sparkles,
  SquareArrowOutUpRight,
  Undo2,
  User,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { messageDeliveryVisual } from '@/features/chat/deliveryStatus';
import { MessageBubbleShapeBackdrop, humanMessageBubbleShapeClass } from '@/features/chat/messageBubbleShape';
import { selfDisplayName } from '@/lib/identityLabels';
import { cn } from '@/lib/utils';
import { IdentityAvatar, useLocalAgentAvatarSeed, useLocalProfileAvatarSeed, type IdentityAvatarKind } from './IdentityAvatar';
import { MarkdownContent } from './markdown';
import { AttachmentPreview } from './transcriptAttachments';
import { RequestReplyLine, transcriptMessageDomId } from './transcriptReplyAttribution';
import { LiveChatTurnCard, LiveChatTurnMessage, liveTurnSnapshotKey, type StopBridgeAgentRequestHandler } from './transcriptLiveTurns';
export { LiveChatTurnCard, LiveChatTurnMessage };
import type {
  Contact,
  ContactRequest,
  ConversationType,
  EditFilePreview,
  Message,
  MessageMention,
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

function MessageDeliveryGlyph({ status }: { status: string }) {
  const visual = messageDeliveryVisual(status);
  if (!visual) return null;

  const toneClass = visual.tone === 'blue'
    ? 'text-sky-400'
    : visual.tone === 'red'
      ? 'text-rose-400'
      : 'text-slate-400';

  if (visual.glyph === 'single-check') {
    return <Check className={cn('h-3.5 w-3.5', toneClass)} aria-hidden="true" />;
  }
  if (visual.glyph === 'double-check') {
    return <CheckCheck className={cn('h-3.5 w-3.5', toneClass)} aria-hidden="true" />;
  }
  if (visual.glyph === 'clock') {
    return <Clock3 className={cn('h-3.5 w-3.5', toneClass)} aria-hidden="true" />;
  }
  if (visual.glyph === 'spinner') {
    return <LoaderCircle className={cn('h-3.5 w-3.5 animate-spin', toneClass)} aria-hidden="true" />;
  }
  if (visual.glyph === 'exclamation') {
    return (
      <span className={cn('inline-flex h-3.5 w-3.5 items-center justify-center text-[13px] font-semibold leading-none', toneClass)} aria-hidden="true">
        !
      </span>
    );
  }
  return null;
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
  const visual = messageDeliveryVisual(status);
  const glyph = status ? <MessageDeliveryGlyph status={status} /> : null;
  const showFailedLabel = visual?.tone === 'red';
  const showDetail = detail && (!status || (status !== 'read' && status !== 'responded'));

  return (
    <div className={cn(
      'app-message-footer flex items-center gap-1.5 text-[10px] leading-none tabular-nums',
      compact ? 'shrink-0 self-end whitespace-nowrap pl-2 min-w-[4.6rem] justify-end' : 'mt-1.5 justify-end',
      isUser ? 'text-black/45' : 'text-slate-500/80',
    )}>
      {showDetail ? <span className="truncate text-[10px]">{detail}</span> : null}
      {showFailedLabel ? <span className="font-semibold text-rose-400">{visual.label}</span> : null}
      <span className="inline-block min-w-[2.5rem] text-right">{time}</span>
      <span className="inline-flex w-4 justify-center" title={visual?.label ?? status ?? undefined}>
        {glyph}
      </span>
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

function MessageBubbleView({
  msg,
  onOpenSource,
  onStopBridgeAgentRequest,
  onNavigateToMessage,
  isGroupedWithPrevious = false,
  isGroupedWithNext = false,
}: {
  msg: Message;
  onOpenSource?: (file: EditFilePreview) => void;
  onStopBridgeAgentRequest?: StopBridgeAgentRequestHandler;
  onNavigateToMessage?: (messageId: string) => void;
  isGroupedWithPrevious?: boolean;
  isGroupedWithNext?: boolean;
}) {
  const [isEditExpanded, setIsEditExpanded] = useState(true);
  const currentLocalProfileAvatarSeed = useLocalProfileAvatarSeed();
  const currentLocalAgentAvatarSeed = useLocalAgentAvatarSeed(msg.sender);

  if (isCompactionSummaryMessage(msg)) {
    return <CompactionSummaryMessage msg={msg} />;
  }

  if (msg.role === 'system') {
    return (
      <div className="app-system-notice-row flex justify-center py-0.5">
        <div className="app-system-notice-pill max-w-[min(100%,34rem)] truncate rounded-full border bg-muted px-2.5 py-0.5 text-center text-[11px] leading-5 text-muted-foreground">{msg.text}</div>
      </div>
    );
  }

  if (msg.role === 'action') {
    return (
      <div className="my-2 max-w-[42rem] rounded-2xl border bg-card p-4 shadow-sm">
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
      </div>
    );
  }

  if (msg.role === 'edit' && msg.edit) {
    const primaryFile = msg.edit.files[0];

    return (
      <div className="flex flex-col items-start gap-0.5 py-0.5">
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
      </div>
    );
  }

  if (msg.turn) {
    return (
      <div
        id={msg.id || msg.turn.id ? transcriptMessageDomId(msg.id ?? msg.turn.id) : undefined}
        className="flex w-full max-w-[min(100%,58rem)] flex-col items-start gap-0.5 py-0.5"
      >
        <div className="app-message-meta">
          {msg.sender} • {msg.time}
        </div>
        <LiveChatTurnCard
          turn={msg.turn}
          historical={msg.turn.completed}
          onStopBridgeAgentRequest={onStopBridgeAgentRequest}
          onNavigateToMessage={onNavigateToMessage}
        />
      </div>
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
  const showInlineCompactFooter = showCompactFooter && hasText && !hasAttachments;
  const avatarKind: IdentityAvatarKind = isAgentMessage ? 'agent' : 'human';
  const avatarName = selfDisplayName(msg.sender || (isOwnHumanMessage ? 'Me' : avatarKind === 'agent' ? 'Agent' : 'Person'), isOwnHumanMessage);
  const avatarSeed = isOwnHumanMessage
    ? currentLocalProfileAvatarSeed
    : msg.role === 'owned-agent'
      ? currentLocalAgentAvatarSeed
      : msg.senderAvatarSeed?.trim() || `${avatarKind}:${avatarName}`;
  const showInlineHumanSender = Boolean(!isAgentMessage && msg.showSenderMeta && msg.sender && !isGroupedWithPrevious);
  const showAvatarSlot = !isAgentMessage;
  const showAvatar = showAvatarSlot && !isGroupedWithNext;

  return (
    <div
      id={msg.id ? transcriptMessageDomId(msg.id) : undefined}
      className={cn(
        'flex flex-col gap-1',
        isGroupedWithPrevious ? 'pt-0.5' : 'pt-1',
        isGroupedWithNext ? 'pb-0' : 'pb-1',
        align,
        isAgentMessage ? 'w-full max-w-[min(100%,42rem)]' : '',
      )}
    >
      {showHeaderMeta ? (
        <div className="app-message-meta px-1">
          {isAgentMessage ? msg.sender : showCompactFooter ? msg.sender : `${msg.sender} • ${msg.time}`}
        </div>
      ) : null}
      <div className={cn('flex items-end', showAvatarSlot ? 'gap-2' : 'gap-0', isOwnHumanMessage ? 'flex-row-reverse' : 'flex-row', isAgentMessage ? 'w-full' : '')}>
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
        <div className={cn(
          'min-w-0 shadow-sm',
          isOwnHumanMessage || isPeerHumanMessage ? 'text-[14px]' : 'text-[13px]',
          isOwnHumanMessage
            ? cn('w-fit min-w-[6.75rem] max-w-[34rem] px-4 py-2.5', humanMessageBubbleShapeClass('own'))
            : isPeerHumanMessage
              ? cn('w-fit min-w-[6.75rem] max-w-[34rem] px-4 py-2.5', humanMessageBubbleShapeClass('peer'))
              : 'w-fit max-w-full rounded-[20px] px-3.5 py-2.5',
          bubble,
        )}>
        {isOwnHumanMessage ? <MessageBubbleShapeBackdrop side="own" /> : null}
        {isPeerHumanMessage ? <MessageBubbleShapeBackdrop side="peer" /> : null}
        {showInlineHumanSender ? (
          <div
            className="app-message-inline-sender mb-1 truncate text-[12px] font-semibold leading-4"
            style={senderAccentStyle(msg.sender)}
          >
            {msg.sender}
          </div>
        ) : null}
        {showCompactFooter ? (
          showInlineCompactFooter ? (
            <div className="leading-[1.45]">
              <span className="whitespace-pre-wrap break-words">
                {renderTextWithMentionPills(msg.text, msg.mentions)}
              </span>
              <span className={cn(
                'app-message-footer app-message-compact-footer ml-4 inline-flex translate-y-[1px] items-center gap-1 whitespace-nowrap text-[9.5px] leading-none tabular-nums',
                isOwnHumanMessage ? 'text-black/45' : 'text-slate-500/80',
              )}>
                {msg.detail && (!deliveryStatus || (deliveryStatus !== 'read' && deliveryStatus !== 'responded')) ? (
                  <span>{msg.detail}</span>
                ) : null}
                {isOwnHumanMessage && deliveryVisual?.tone === 'red' ? (
                  <span className="font-semibold text-rose-400">{deliveryVisual.label}</span>
                ) : null}
                <span>{msg.time}</span>
                {isOwnHumanMessage && deliveryStatus ? MessageDeliveryGlyph({ status: deliveryStatus }) : null}
              </span>
            </div>
          ) : (
            <>
              <div className={cn('flex flex-col', hasAttachments && hasText ? 'gap-2.5' : 'gap-0')}>
                {hasAttachments ? <AttachmentPreview msg={msg} /> : null}
                {hasText ? <div className="whitespace-pre-wrap break-words">{renderTextWithMentionPills(msg.text, msg.mentions)}</div> : null}
              </div>
              <MessageFooter
                time={msg.time}
                status={isOwnHumanMessage ? deliveryStatus : undefined}
                detail={msg.detail}
                isUser={isOwnHumanMessage}
              />
            </>
          )
        ) : (
          <>
            <div className={cn('flex flex-col', hasAttachments && hasText ? 'gap-2.5' : 'gap-0')}>
              {hasAttachments ? <AttachmentPreview msg={msg} /> : null}
              {hasText ? <MarkdownContent text={msg.text} /> : null}
            </div>
            {(msg.statusChips?.length || msg.detail) ? (
              <div className={cn('app-message-status-bar border-t border-white/10 pt-2 text-[11px] text-slate-300', hasAttachments || hasText ? 'mt-2' : '')}>
                {msg.statusChips?.map((chip) => (
                  <span key={chip} className="app-message-status-chip inline-flex items-center rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] text-slate-300">
                    {chip}
                  </span>
                ))}
                {msg.detail ? <span className="text-slate-400">{msg.detail}</span> : null}
              </div>
            ) : null}
          </>
        )}
        </div>
      </div>
      {showCompactFooter ? (
        <RequestReplyLine
          summary={msg.replySummary}
          own={isOwnHumanMessage}
          onNavigateToMessage={onNavigateToMessage}
        />
      ) : null}
    </div>
  );
}

function messageSnapshotKey(msg: Message) {
  return [
    msg.id ?? '',
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
}: {
  request: ContactRequest;
  active: boolean;
  onReview: () => void;
}) {
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
          seed={request.id}
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
            <Button variant="secondary" className="h-8 rounded-xl px-3 text-[11px]" onClick={onReview}>
              Review details
            </Button>
            <Button className="h-8 rounded-xl px-3 text-[11px]">Accept</Button>
            <Button variant="secondary" className="h-8 rounded-xl px-3 text-[11px]">
              Reject
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
