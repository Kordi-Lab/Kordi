import { memo, useEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties, type ReactNode } from 'react';
import {
  ArrowRightLeft,
  Bot,
  Braces,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  Clock3,
  FileText,
  FolderOpen,
  Globe,
  Image,
  Link2,
  LoaderCircle,
  Pencil,
  Search,
  Sparkles,
  SquareArrowOutUpRight,
  TerminalSquare,
  Undo2,
  User,
  Wrench,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { messageDeliveryVisual } from '@/features/chat/deliveryStatus';
import { selfDisplayName } from '@/lib/identityLabels';
import { cn } from '@/lib/utils';
import { IdentityAvatar, useLocalAgentAvatarSeed, useLocalProfileAvatarSeed, type IdentityAvatarKind } from './IdentityAvatar';
import { isDiffLikeOutput, parseDiffOutput, stripAnsi, type ParsedDiffLine } from './diffOutput';
import { MarkdownCodeBlock, MarkdownContent } from './markdown';
import { firstMeaningfulThinkingLine, formatRunningElapsed, toolTimelineFoldedLabel, toolTimelineToolLabel, toolTimelineTypeLabel } from './toolTimeline';
import type {
  Contact,
  ContactRequest,
  ConversationType,
  DesktopChatTurnSnapshot,
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

function looksLikeTerminalTable(text: string) {
  const lines = text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  if (lines.length < 3) return false;

  const columnishLines = lines.filter((line) => /\S(?:\s{2,}|\t+)\S/.test(line));
  const dividerLines = lines.filter((line) => /^[-=\s]{6,}$/.test(line));

  return columnishLines.length >= 2 || dividerLines.length >= 1;
}

function DiffOutputBlock({ label, icon, text }: { label: string; icon: ComponentType<{ className?: string }>; text: string }) {
  const Icon = icon;
  const rows = useMemo(() => parseDiffOutput(text), [text]);
  const fileRows = rows.filter((row) => row.kind === 'file');
  const bodyRows = rows.filter((row) => row.kind !== 'file');
  const classForRow = (row: ParsedDiffLine) => cn(
    'app-transcript-diff-row',
    row.kind === 'add' && 'app-transcript-diff-row-add',
    row.kind === 'delete' && 'app-transcript-diff-row-delete',
    row.kind === 'hunk' && 'app-transcript-diff-row-hunk',
  );

  return (
    <div className="py-1.5">
      <div className="app-transcript-block-label mb-1.5 flex items-center gap-2 text-[10px] font-medium text-slate-500">
        <Icon className="h-3.5 w-3.5" />
        <span>{label}</span>
        <span className="app-transcript-utility-chip rounded-full bg-white/6 px-2 py-0.5 text-[10px] text-slate-400">patch</span>
      </div>
      <div className="app-transcript-diff-block">
        {fileRows.length > 0 ? (
          <div className="app-transcript-diff-files">
            {fileRows.map((row, index) => <div key={`diff-file-${index}`} className="truncate">{row.content}</div>)}
          </div>
        ) : null}
        <div className="app-transcript-diff-scroll">
          <div className="app-transcript-diff-table" role="table" aria-label={`${label} patch`}>
            {bodyRows.map((row, index) => (
              <div key={`diff-row-${index}`} className={classForRow(row)} role="row">
                <span className="app-transcript-diff-gutter" role="cell">{row.oldLineNumber ?? ''}</span>
                <span className="app-transcript-diff-gutter" role="cell">{row.newLineNumber ?? ''}</span>
                <span className="app-transcript-diff-marker" role="cell">{row.kind === 'add' ? '+' : row.kind === 'delete' ? '-' : ' '}</span>
                <code className="app-transcript-diff-code" role="cell">{row.content || ' '}</code>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function ToolTranscriptBlock({
  label,
  icon,
  text,
  maxHeightClass,
  language,
  wrapLines,
}: {
  label: string;
  icon: ComponentType<{ className?: string }>;
  text: string;
  maxHeightClass?: string;
  language?: string;
  wrapLines?: boolean;
}) {
  const Icon = icon;
  const cleanedText = useMemo(() => stripAnsi(text), [text]);
  const preserveColumns = useMemo(() => looksLikeTerminalTable(cleanedText), [cleanedText]);
  const [isWrapped, setIsWrapped] = useState(wrapLines ?? !preserveColumns);

  if (isDiffLikeOutput(cleanedText)) {
    return <DiffOutputBlock label={label} icon={icon} text={cleanedText} />;
  }

  return (
    <div className="py-1.5">
      <div className="app-transcript-block-label mb-1.5 flex items-center gap-2 text-[10px] font-medium text-slate-500">
        <Icon className="h-3.5 w-3.5" />
        <span>{label}</span>
        {preserveColumns ? <span className="app-transcript-utility-chip rounded-full bg-white/6 px-2 py-0.5 text-[10px] text-slate-400">column layout</span> : null}
      </div>
      <MarkdownCodeBlock
        code={cleanedText}
        language={language}
        maxHeightClass={maxHeightClass}
        wrapLines={isWrapped}
        headerActions={
          <button
            type="button"
            onClick={() => setIsWrapped((current) => !current)}
            className="app-transcript-wrap-toggle rounded-lg bg-white/5 px-2 py-1 text-[11px] font-medium text-slate-300 transition hover:bg-white/10 hover:text-white"
          >
            {isWrapped ? 'No wrap' : 'Wrap'}
          </button>
        }
      />
    </div>
  );
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

function ProcessingStatusCircle({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-3.5 w-3.5 shrink-0 rounded-full border-[1.5px] border-current/25 border-t-current text-white/75',
        'animate-spin motion-reduce:animate-none',
        className,
      )}
      aria-hidden="true"
    />
  );
}

function mentionPill(label: string, key: string) {
  return (
    <span
      key={key}
      className="inline-flex translate-y-[-1px] items-center rounded-full border border-sky-300/25 bg-sky-300/12 px-1.5 py-0.5 text-[0.92em] font-medium text-sky-100"
    >
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
  if (visual.glyph === 'error') {
    return <CircleAlert className={cn('h-3.5 w-3.5', toneClass)} aria-hidden="true" />;
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
  const glyph = status ? <MessageDeliveryGlyph status={status} /> : null;
  const showDetail = detail && (!status || (status !== 'read' && status !== 'responded'));

  return (
    <div className={cn(
      'flex items-center gap-1.5 text-[10px] leading-none tabular-nums',
      compact ? 'shrink-0 self-end whitespace-nowrap pl-2 min-w-[4.6rem] justify-end' : 'mt-1.5 justify-end',
      isUser ? 'text-black/58' : 'text-slate-500',
    )}>
      {showDetail ? <span className="truncate text-[10px]">{detail}</span> : null}
      <span className="inline-block min-w-[2.5rem] text-right">{time}</span>
      <span className="inline-flex w-4 justify-center" title={status ?? undefined}>
        {glyph}
      </span>
    </div>
  );
}

function AttachmentPreview({ msg }: { msg: Message }) {
  const attachments = msg.attachments ?? [];
  const imageAttachments = attachments.filter((attachment) => attachment.kind === 'image');
  const fileAttachments = attachments.filter((attachment) => attachment.kind !== 'image');

  if (attachments.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2">
      {imageAttachments.length > 0 ? (
        <div className={cn('grid gap-2', imageAttachments.length > 1 ? 'sm:grid-cols-2' : 'grid-cols-1')}>
          {imageAttachments.map((attachment, index) => (
            <div key={`${attachment.name}-${index}`} className="overflow-hidden rounded-[16px] border border-white/10 bg-black/10">
              {attachment.previewUrl ? (
                <img
                  src={attachment.previewUrl}
                  alt={attachment.name || 'Attached image'}
                  className="block max-h-[320px] w-full object-cover"
                />
              ) : (
                <div className="flex h-28 items-center justify-center bg-white/5 text-slate-400">
                  <Image className="h-5 w-5" />
                </div>
              )}
              <div className="flex items-center justify-between gap-2 px-3 py-2 text-[11px] text-slate-300">
                <span className="truncate">{attachment.name || 'Image attachment'}</span>
                {attachment.formatLabel ? (
                  <span className="shrink-0 text-[10px] font-medium uppercase tracking-[0.14em] text-slate-400">
                    {attachment.formatLabel}
                  </span>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {fileAttachments.length > 0 ? (
        <div className="flex flex-col gap-2">
          {fileAttachments.map((attachment, index) => (
            <div key={`${attachment.name}-${index}`} className="flex items-center gap-3 rounded-[14px] border border-white/10 bg-black/10 px-3 py-2.5">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/6 text-slate-200">
                <FileText className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] font-medium text-white/92">{attachment.name}</div>
                <div className="mt-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-slate-400">
                  {attachment.formatLabel || 'FILE'}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : null}
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

function MessageBubbleView({ msg, onOpenSource }: { msg: Message; onOpenSource?: (file: EditFilePreview) => void }) {
  const [isEditExpanded, setIsEditExpanded] = useState(true);
  const currentLocalProfileAvatarSeed = useLocalProfileAvatarSeed();
  const currentLocalAgentAvatarSeed = useLocalAgentAvatarSeed(msg.sender);

  if (isCompactionSummaryMessage(msg)) {
    return <CompactionSummaryMessage msg={msg} />;
  }

  if (msg.role === 'system') {
    return (
      <div className="flex justify-center py-2">
        <div className="max-w-[min(100%,44rem)] rounded-full border bg-muted px-3 py-1 text-center text-xs text-muted-foreground">{msg.text}</div>
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
      <div className="flex w-full max-w-[min(100%,58rem)] flex-col items-start gap-0.5 py-0.5">
        <div className="app-message-meta">
          {msg.sender} • {msg.time}
        </div>
        <LiveChatTurnCard turn={msg.turn} historical={msg.turn.completed} />
      </div>
    );
  }

  const isOwnHumanMessage = (msg.isOwnMessage ?? (msg.role === 'user')) && (msg.senderType ?? 'human') === 'human';
  const isPeerHumanMessage = !isOwnHumanMessage && ((msg.senderType === 'human') || msg.role === 'person');
  const isAgentMessage = !isOwnHumanMessage && !isPeerHumanMessage;
  const align = isOwnHumanMessage ? 'items-end' : 'items-start';
  const bubble = isOwnHumanMessage ? 'app-chat-bubble-user' : 'app-chat-bubble-peer';
  const deliveryStatus = primaryMessageStatus(msg);
  const showCompactFooter = isOwnHumanMessage || isPeerHumanMessage;
  const showHeaderMeta = Boolean((msg.showSenderMeta || isAgentMessage) && msg.sender);
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
  const showAvatar = !isAgentMessage;

  return (
    <div className={cn('flex flex-col gap-1 py-1', align, isAgentMessage ? 'w-full max-w-[min(100%,42rem)]' : '')}>
      {showHeaderMeta ? (
        <div className="app-message-meta px-1">
          {isAgentMessage ? msg.sender : showCompactFooter ? msg.sender : `${msg.sender} • ${msg.time}`}
        </div>
      ) : null}
      <div className={cn('flex items-end', showAvatar ? 'gap-2' : 'gap-0', isOwnHumanMessage ? 'flex-row-reverse' : 'flex-row', isAgentMessage ? 'w-full' : '')}>
        {showAvatar ? (
          <IdentityAvatar
            kind={avatarKind}
            seed={avatarSeed}
            name={avatarName}
            imageUrl={msg.senderProfileImageUrl}
            className="mb-0.5 h-7 w-7 border border-white/10"
          />
        ) : null}
        <div className={cn(
          'min-w-0 overflow-hidden text-[13px] shadow-sm',
          isOwnHumanMessage
            ? 'w-fit max-w-[26rem] rounded-[20px] rounded-br-[6px] px-3 py-2'
            : isPeerHumanMessage
              ? 'w-fit max-w-[26rem] rounded-[20px] rounded-bl-[6px] px-3 py-2'
              : 'w-fit max-w-full rounded-[20px] px-3.5 py-2.5',
          bubble,
        )}>
        {showCompactFooter ? (
          showInlineCompactFooter ? (
            <div className="leading-[1.45]">
              <span className="whitespace-pre-wrap break-words">
                {renderTextWithMentionPills(msg.text, msg.mentions)}
              </span>
              <span className={cn(
                'ml-2 inline-flex translate-y-[1px] items-center gap-1 whitespace-nowrap text-[10px] leading-none tabular-nums',
                isOwnHumanMessage ? 'text-black/54' : 'text-slate-500',
              )}>
                {msg.detail && (!deliveryStatus || (deliveryStatus !== 'read' && deliveryStatus !== 'responded')) ? (
                  <span>{msg.detail}</span>
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
    </div>
  );
}

function messageSnapshotKey(msg: Message) {
  return [
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
    msg.attachments?.map((attachment) => [attachment.kind, attachment.name, attachment.formatLabel ?? '', attachment.previewUrl ?? ''].join(':')).join('|') ?? '',
    msg.mentions?.map((mention) => mention.label).join('|') ?? '',
    msg.turn ? liveTurnSnapshotKey(msg.turn) : '',
    msg.edit?.files.map((file) => [file.path, file.additions, file.deletions, file.lines.length].join(':')).join('|') ?? '',
  ].join('\u0001');
}

export const MessageBubble = memo(
  MessageBubbleView,
  (previous, next) => previous.msg === next.msg || messageSnapshotKey(previous.msg) === messageSnapshotKey(next.msg),
);

function toolDisplayConfig(toolName: string) {
  const normalized = toolName.toLowerCase();

  if (normalized === 'reach_out') {
    return { icon: ArrowRightLeft, label: '@ participant', argumentsLabel: 'Request', resultLabel: 'Participant response' };
  }
  if (normalized.includes('web_fetch')) {
    return { icon: Globe };
  }
  if (normalized.includes('browser_fetch')) {
    return { icon: Link2 };
  }
  if (normalized.includes('search') || normalized.includes('grep')) {
    return { icon: Search };
  }
  if (normalized.includes('read') || normalized.includes('view') || normalized.includes('cat')) {
    return { icon: FileText };
  }
  if (normalized.includes('list') || normalized.includes('glob') || normalized.includes('find') || normalized.includes('dir')) {
    return { icon: FolderOpen };
  }
  if (normalized.includes('bash') || normalized.includes('shell') || normalized.includes('command') || normalized.includes('terminal')) {
    return { icon: TerminalSquare };
  }
  if (normalized.includes('edit') || normalized.includes('write') || normalized.includes('patch')) {
    return { icon: Pencil };
  }
  if (normalized.includes('image')) {
    return { icon: Image };
  }

  return { icon: Wrench };
}

type ToolSnapshot = DesktopChatTurnSnapshot['tools'][number];
type ToolDisplay = ReturnType<typeof toolDisplayConfig>;


function normalizedToolStatus(tool: ToolSnapshot) {
  return (tool.isError ? 'error' : tool.status || 'pending').trim().toLowerCase();
}

function isFailedTool(tool: ToolSnapshot) {
  const status = normalizedToolStatus(tool);
  return tool.isError || status === 'error' || status.includes('failed');
}

function isDoneTool(tool: ToolSnapshot) {
  const status = normalizedToolStatus(tool);
  return !isFailedTool(tool) && (status === 'done' || status === 'complete' || status === 'completed');
}

function isRunningTool(tool: ToolSnapshot) {
  return !isDoneTool(tool) && !isFailedTool(tool);
}

function statusLabelForTool(tool: ToolSnapshot) {
  if (isFailedTool(tool)) return 'error';
  if (isDoneTool(tool)) return 'done';
  const status = normalizedToolStatus(tool);
  return status || 'running';
}

function toolMetaText(tool: ToolSnapshot) {
  return tool.detail || tool.status;
}

function toolDetailsAvailable(tool: ToolSnapshot) {
  return Boolean(tool.arguments || tool.liveOutput || tool.resultText);
}

function ToolDetailBlocks({ tool, display }: { tool: ToolSnapshot; display: ToolDisplay }) {
  return (
    <div>
      {tool.arguments ? <ToolTranscriptBlock label={display.argumentsLabel ?? 'Arguments'} icon={Braces} text={tool.arguments} language="json" maxHeightClass="max-h-56" wrapLines /> : null}
      {tool.liveOutput ? <ToolTranscriptBlock label="Live output" icon={TerminalSquare} text={tool.liveOutput} language="text" maxHeightClass="max-h-64" /> : null}
      {tool.resultText ? <ToolTranscriptBlock label={display.resultLabel ?? 'Result'} icon={CheckCircle2} text={tool.resultText} language="text" maxHeightClass="max-h-72" /> : null}
    </div>
  );
}

function ToolTimelineDetails({ tool, display }: { tool: ToolSnapshot; display: ToolDisplay }) {
  const [expandedDetails, setExpandedDetails] = useState(false);

  if (!toolDetailsAvailable(tool)) return null;

  return (
    <div className="app-transcript-timeline-details">
      <button
        type="button"
        className="app-transcript-timeline-details-toggle"
        onClick={() => setExpandedDetails((current) => !current)}
        aria-expanded={expandedDetails}
      >
        <ChevronRight className={cn('h-3 w-3 transition-transform', expandedDetails && 'rotate-90')} />
        <span>Details</span>
      </button>
      {expandedDetails ? (
        <div className="app-transcript-timeline-details-body">
          <ToolDetailBlocks tool={tool} display={display} />
        </div>
      ) : null}
    </div>
  );
}

function ToolTimelineThinkingRow({ thinkingText }: { thinkingText: string }) {
  const [expandedThinking, setExpandedThinking] = useState(false);
  const summary = firstMeaningfulThinkingLine(thinkingText);
  const hasMoreThinking = thinkingText.trim() !== summary;

  return (
    <div className="app-transcript-timeline-row app-transcript-timeline-row-thinking">
      <span className="app-transcript-timeline-rail" aria-hidden="true">
        <span className="app-transcript-timeline-node"><Clock3 className="h-3.5 w-3.5" /></span>
      </span>
      <div className="app-transcript-timeline-row-body">
        <div className="app-transcript-timeline-row-line">
          <span className="app-transcript-timeline-row-title">{summary}</span>
          <span className="app-transcript-timeline-pill">Thinking</span>
        </div>
        {hasMoreThinking ? (
          <div className="app-transcript-timeline-details">
            <button
              type="button"
              className="app-transcript-timeline-details-toggle"
              onClick={() => setExpandedThinking((current) => !current)}
              aria-expanded={expandedThinking}
            >
              <ChevronRight className={cn('h-3 w-3 transition-transform', expandedThinking && 'rotate-90')} />
              <span>Reasoning</span>
            </button>
            {expandedThinking ? (
              <div className="app-transcript-timeline-details-body pr-1">
                <MarkdownContent text={thinkingText} tone="muted" className="text-[12.5px] leading-[1.55rem]" />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function useRunningElapsedLabel(running: boolean) {
  const startedAtRef = useRef<number | null>(running ? Date.now() : null);
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (!running) {
      startedAtRef.current = null;
      setElapsedMs(0);
      return undefined;
    }

    if (startedAtRef.current === null) {
      startedAtRef.current = Date.now();
    }

    const updateElapsed = () => setElapsedMs(Date.now() - (startedAtRef.current ?? Date.now()));
    updateElapsed();
    const interval = window.setInterval(updateElapsed, 1_000);
    return () => window.clearInterval(interval);
  }, [running]);

  return running ? formatRunningElapsed(elapsedMs) : null;
}

function ToolTimelineToolRow({ tool }: { tool: ToolSnapshot }) {
  const display = toolDisplayConfig(tool.name);
  const Icon = display.icon;
  const status = statusLabelForTool(tool);
  const metaText = toolMetaText(tool);
  const running = isRunningTool(tool);
  const typeLabel = toolTimelineTypeLabel(tool);
  const label = running && typeLabel === 'Script' ? 'Running command' : toolTimelineToolLabel(tool);
  const runningElapsed = useRunningElapsedLabel(running);

  return (
    <div className={cn('app-transcript-timeline-row', running && 'app-transcript-timeline-row-running')}>
      <span className="app-transcript-timeline-rail" aria-hidden="true">
        <span className="app-transcript-timeline-node">
          <Icon className="h-3.5 w-3.5" />
        </span>
      </span>
      <div
        className="app-transcript-timeline-row-body"
        aria-label={`${label}, ${status}${runningElapsed ? `, ${runningElapsed}` : ''}${metaText ? `, ${metaText}` : ''}`}
      >
        <div className="app-transcript-timeline-row-line">
          <span className="app-transcript-timeline-row-title">{label}</span>
        </div>
        <div className="app-transcript-timeline-row-subline">
          <span className="app-transcript-timeline-pill">{typeLabel}</span>
          {runningElapsed ? <span className="app-transcript-timeline-running-time">{runningElapsed}</span> : null}
        </div>
        {isFailedTool(tool) && metaText && metaText !== status ? <div className="app-transcript-timeline-row-meta truncate">{metaText}</div> : null}
        <ToolTimelineDetails tool={tool} display={display} />
      </div>
    </div>
  );
}

function ToolTimelineCompletionRow({ failed }: { failed: boolean }) {
  return (
    <div className={cn('app-transcript-timeline-row app-transcript-timeline-row-complete', failed && 'app-transcript-timeline-row-error')}>
      <span className="app-transcript-timeline-rail" aria-hidden="true">
        <span className="app-transcript-timeline-node">
          {failed ? <CircleAlert className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
        </span>
      </span>
      <div className="app-transcript-timeline-row-body">
        <div className="app-transcript-timeline-row-line">
          <span className="app-transcript-timeline-row-title">{failed ? 'Needs attention' : 'Done'}</span>
          <span className="app-transcript-timeline-pill">{failed ? 'Issue' : 'Complete'}</span>
        </div>
      </div>
    </div>
  );
}

function FoldableToolTimeline({
  tools,
  thinkingText,
  active,
  completed,
}: {
  tools: ToolSnapshot[];
  thinkingText: string;
  active: boolean;
  completed: boolean;
}) {
  const [expandedTimeline, setExpandedTimeline] = useState(false);
  const hasThinking = thinkingText.trim().length > 0;
  const failed = tools.some(isFailedTool);
  const summary = toolTimelineFoldedLabel({ tools, active, completed, thinkingText });

  if (!hasThinking && tools.length === 0) return null;

  return (
    <section className={cn('app-transcript-tool-timeline', active && 'app-transcript-tool-timeline-active')}>
      <button
        type="button"
        className={cn('app-transcript-tool-timeline-summary', active && 'app-transcript-tool-timeline-summary-active')}
        onClick={() => setExpandedTimeline((current) => !current)}
        aria-expanded={expandedTimeline}
      >
        <span className="app-transcript-tool-timeline-summary-copy min-w-0">
          <span className="app-transcript-tool-timeline-summary-line min-w-0">
            <span className="app-transcript-tool-timeline-summary-text truncate">{summary}</span>
            <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 transition-transform', expandedTimeline && 'rotate-90')} aria-hidden="true" />
          </span>
        </span>
      </button>

      {expandedTimeline ? (
        <div className="app-transcript-timeline-list">
          {hasThinking ? <ToolTimelineThinkingRow thinkingText={thinkingText} /> : null}
          {tools.map((tool) => <ToolTimelineToolRow key={tool.id} tool={tool} />)}
          {completed || failed ? <ToolTimelineCompletionRow failed={failed} /> : null}
        </div>
      ) : null}
    </section>
  );
}

function longerText(current: string, next: string) {
  return next.length >= current.length ? next : current;
}

function mergeVisibleToolSnapshot(
  current: DesktopChatTurnSnapshot['tools'][number],
  next: DesktopChatTurnSnapshot['tools'][number],
): DesktopChatTurnSnapshot['tools'][number] {
  return {
    ...current,
    ...next,
    arguments: longerText(current.arguments ?? '', next.arguments ?? ''),
    liveOutput: longerText(current.liveOutput ?? '', next.liveOutput ?? ''),
    resultText: next.resultText || current.resultText,
    detail: next.detail || current.detail,
  };
}

function mergeVisibleLiveTurn(
  current: DesktopChatTurnSnapshot,
  next: DesktopChatTurnSnapshot,
): DesktopChatTurnSnapshot {
  const currentToolsById = new Map(current.tools.map((tool) => [tool.id, tool]));
  const nextToolIds = new Set(next.tools.map((tool) => tool.id));
  const mergedTools = next.tools.map((tool) => {
    const existing = currentToolsById.get(tool.id);
    return existing ? mergeVisibleToolSnapshot(existing, tool) : tool;
  });

  return {
    ...current,
    ...next,
    assistantText: longerText(current.assistantText, next.assistantText),
    thinkingText: longerText(current.thinkingText, next.thinkingText),
    tools: [
      ...mergedTools,
      ...current.tools.filter((tool) => !nextToolIds.has(tool.id)),
    ],
  };
}

function useVisibleLiveTurn(turn: DesktopChatTurnSnapshot, historical: boolean) {
  const visibleTurnRef = useRef<DesktopChatTurnSnapshot>(turn);
  if (historical || visibleTurnRef.current.id !== turn.id) {
    visibleTurnRef.current = turn;
  } else {
    visibleTurnRef.current = mergeVisibleLiveTurn(visibleTurnRef.current, turn);
  }
  return visibleTurnRef.current;
}

function useDelayedLiveStatus(shouldShow: boolean, turnId: string, delayMs = 180) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!shouldShow) {
      setVisible(false);
      return undefined;
    }

    setVisible(false);
    const timeout = window.setTimeout(() => {
      setVisible(true);
    }, delayMs);
    return () => window.clearTimeout(timeout);
  }, [delayMs, shouldShow, turnId]);

  return shouldShow && visible;
}

function LiveChatTurnCardView({ turn, historical = false }: { turn: DesktopChatTurnSnapshot; historical?: boolean }) {
  const visibleTurn = useVisibleLiveTurn(turn, historical);
  const hasAssistant = visibleTurn.assistantText.trim().length > 0;
  const hasThinking = visibleTurn.thinkingText.trim().length > 0;
  const hasVisibleContent = hasAssistant || hasThinking || visibleTurn.tools.length > 0 || Boolean(visibleTurn.error);
  const isCompressionStatus = visibleTurn.status === 'compacting' || visibleTurn.status === 'compacted' || visibleTurn.status === 'compaction_failed';
  const shouldShowLiveStatusHeader = !historical && !visibleTurn.completed && !hasVisibleContent && !isCompressionStatus;
  const showLiveStatusHeader = useDelayedLiveStatus(shouldShowLiveStatusHeader, visibleTurn.id);
  const liveStatusText = visibleTurn.message?.trim().length
    ? visibleTurn.message
    : visibleTurn.status === 'cancelling'
      ? 'Stopping…'
      : visibleTurn.status === 'retrying'
        ? 'Retrying…'
        : visibleTurn.status === 'compacting'
          ? 'Compressing conversation…'
          : visibleTurn.status === 'compacted'
            ? 'Conversation compressed. Continuing…'
            : visibleTurn.status === 'compaction_failed'
              ? 'Compression needs attention'
              : visibleTurn.status === 'typing'
                ? 'Typing…'
                : visibleTurn.status === 'writing'
                  ? 'Replying…'
                  : visibleTurn.status === 'streaming' || visibleTurn.status === 'starting'
                    ? 'Replying…'
                    : 'Working…';
  const liveTurnActive = !historical && !visibleTurn.completed;
  const hasTimelineActivity = hasThinking || visibleTurn.tools.length > 0;

  return (
    <div className="app-live-turn-card w-full max-w-[min(100%,58rem)] space-y-1.5 pb-1.5 [overflow-anchor:auto]">
      {showLiveStatusHeader ? (
        <div className="app-transcript-live-status flex items-center gap-2 text-[11px] font-medium text-slate-400">
          <ProcessingStatusCircle className="h-3.5 w-3.5" />
          <span className="text-slate-300">{liveStatusText}</span>
        </div>
      ) : null}

      {isCompressionStatus ? (
        <div className={cn(
          'app-compression-card rounded-2xl px-4 py-3 text-sm',
          visibleTurn.status === 'compaction_failed'
            ? 'app-compression-card-error'
            : visibleTurn.status === 'compacted'
              ? 'app-compression-card-success'
              : 'app-compression-card-active',
        )}>
          <div className="app-compression-title flex items-center gap-2 font-medium">
            {visibleTurn.status === 'compacting' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : visibleTurn.status === 'compacted' ? <CheckCircle2 className="h-4 w-4" /> : <CircleAlert className="h-4 w-4" />}
            <span>{visibleTurn.status === 'compacting' ? 'Compressing conversation…' : visibleTurn.status === 'compacted' ? 'Conversation compressed' : 'Compression needs attention'}</span>
          </div>
          <div className="app-compression-detail mt-1.5 text-[12px] leading-5">
            {visibleTurn.status === 'compacting'
              ? 'Kordi is summarizing older history before sending the next model request. New messages will wait in the queue.'
              : visibleTurn.status === 'compacted'
                ? 'The preserved summary is in the session and Kordi is continuing with the queued request.'
                : (visibleTurn.error ?? visibleTurn.message)}
          </div>
        </div>
      ) : null}

      {hasTimelineActivity ? (
        <FoldableToolTimeline
          tools={visibleTurn.tools}
          thinkingText={visibleTurn.thinkingText}
          active={liveTurnActive && (visibleTurn.status === 'thinking' || visibleTurn.tools.some(isRunningTool))}
          completed={visibleTurn.completed}
        />
      ) : null}

      {hasAssistant ? (
        <div className="app-live-assistant-answer w-full max-w-[min(100%,46rem)] py-1 text-[13px]">
          <MarkdownContent text={visibleTurn.assistantText} />
        </div>
      ) : null}

      {visibleTurn.error ? (
        <div className="rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">{visibleTurn.error}</div>
      ) : null}
    </div>
  );
}

function liveTurnSnapshotKey(turn: DesktopChatTurnSnapshot) {
  return [
    turn.id,
    turn.sessionId,
    turn.status,
    turn.message,
    turn.assistantText,
    turn.thinkingText,
    turn.completed ? 'completed' : 'running',
    turn.succeeded ? 'succeeded' : 'pending',
    turn.error ?? '',
    turn.transcriptRefreshRequired ? 'refresh' : 'stable',
    ...turn.tools.map((tool) => [
      tool.id,
      tool.name,
      tool.status,
      tool.arguments,
      tool.liveOutput,
      tool.resultText ?? '',
      tool.detail ?? '',
      tool.isError ? 'error' : 'ok',
    ].join('\u0000')),
  ].join('\u0001');
}

export const LiveChatTurnCard = memo(
  LiveChatTurnCardView,
  (previous, next) => previous.historical === next.historical
    && (previous.turn === next.turn || liveTurnSnapshotKey(previous.turn) === liveTurnSnapshotKey(next.turn)),
);

function LiveChatTurnMessageView({ turn, sender = 'My Kordi' }: { turn: DesktopChatTurnSnapshot; sender?: string }) {
  return (
    <div className="flex w-full max-w-[min(100%,58rem)] flex-col items-start gap-0.5 py-0.5">
      <div className="app-message-meta">{sender}</div>
      <LiveChatTurnCard turn={turn} />
    </div>
  );
}

export const LiveChatTurnMessage = memo(
  LiveChatTurnMessageView,
  (previous, next) => previous.sender === next.sender
    && (previous.turn === next.turn || liveTurnSnapshotKey(previous.turn) === liveTurnSnapshotKey(next.turn)),
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
