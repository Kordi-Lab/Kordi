import { useMemo, useState, type ComponentType, type ReactNode } from 'react';
import {
  ArrowRightLeft,
  Bot,
  Braces,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
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

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { MarkdownCodeBlock, MarkdownContent } from './markdown';
import type {
  Contact,
  ContactRequest,
  ConversationType,
  DesktopChatTurnSnapshot,
  EditFilePreview,
  Message,
} from '../types';

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
  const preserveColumns = useMemo(() => looksLikeTerminalTable(text), [text]);
  const [isWrapped, setIsWrapped] = useState(wrapLines ?? !preserveColumns);

  return (
    <div className="py-1.5">
      <div className="mb-1.5 flex items-center gap-2 text-[10px] font-medium text-slate-500">
        <Icon className="h-3.5 w-3.5" />
        <span>{label}</span>
        {preserveColumns ? <span className="rounded-full bg-white/6 px-2 py-0.5 text-[10px] text-slate-400">column layout</span> : null}
      </div>
      <MarkdownCodeBlock
        code={text}
        language={language}
        maxHeightClass={maxHeightClass}
        wrapLines={isWrapped}
        headerActions={
          <button
            type="button"
            onClick={() => setIsWrapped((current) => !current)}
            className="rounded-lg bg-white/5 px-2 py-1 text-[11px] font-medium text-slate-300 transition hover:bg-white/10 hover:text-white"
          >
            {isWrapped ? 'No wrap' : 'Wrap'}
          </button>
        }
      />
    </div>
  );
}

function TimelineSection({
  icon,
  title,
  meta,
  badge,
  expanded,
  onToggle,
  children,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  meta?: string;
  badge?: ReactNode;
  expanded: boolean;
  onToggle: () => void;
  children?: ReactNode;
}) {
  const Icon = icon;

  return (
    <div className="py-0.5">
      <button
        type="button"
        onClick={onToggle}
        className="flex min-h-[30px] w-full items-center justify-between gap-2 rounded-lg px-0.5 py-1 text-left transition hover:bg-white/[0.02]"
      >
        <div className="flex min-w-0 items-center gap-1.5">
          {expanded ? <ChevronDown className="h-4 w-4 shrink-0 text-slate-500" /> : <ChevronRight className="h-4 w-4 shrink-0 text-slate-500" />}
          <Icon className="h-3.5 w-3.5 shrink-0 text-slate-400" />
          <span className="truncate text-[13px] font-medium text-slate-100">{title}</span>
          {meta ? <span className="truncate text-[10px] text-slate-400">{meta}</span> : null}
        </div>
        {badge ? <div className="shrink-0">{badge}</div> : null}
      </button>
      {expanded ? <div className="px-6 pb-0.5 pt-0.5">{children}</div> : null}
    </div>
  );
}

export function TypeBadge({ type }: { type: ConversationType }) {
  if (type === 'person') {
    return (
      <Badge variant="secondary" className="app-badge-neutral gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] leading-none">
        <User className="h-3 w-3" />
        Human
      </Badge>
    );
  }
  if (type === 'owned-agent') {
    return (
      <Badge className="app-badge-owned gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] leading-none">
        <Sparkles className="h-3 w-3" />
        My agent
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="app-badge-neutral gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] leading-none">
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

export function MessageBubble({ msg, onOpenSource }: { msg: Message; onOpenSource?: (file: EditFilePreview) => void }) {
  const [isEditExpanded, setIsEditExpanded] = useState(true);

  if (msg.role === 'system') {
    return (
      <div className="flex justify-center py-2">
        <div className="rounded-full border bg-muted px-3 py-1 text-xs text-muted-foreground">{msg.text}</div>
      </div>
    );
  }

  if (msg.role === 'action') {
    return (
      <div className="my-2 max-w-xl rounded-2xl border bg-card p-4 shadow-sm">
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
        <div className="app-detail-sheet w-full max-w-[680px]">
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
        <LiveChatTurnCard turn={msg.turn} historical />
      </div>
    );
  }

  const isUser = msg.role === 'user';
  const align = isUser ? 'items-end' : 'items-start';
  const bubble = isUser ? 'app-chat-bubble-user' : msg.role === 'owned-agent' ? 'app-chat-bubble-peer' : 'app-chat-bubble-peer';

  return (
    <div className={cn('flex flex-col gap-0.5 py-0.5', align, isUser ? '' : 'w-full max-w-[min(100%,58rem)]')}>
      <div className="app-message-meta">
        {msg.sender} • {msg.time}
      </div>
      <div className={cn('min-w-0 overflow-hidden rounded-[18px] px-3.5 py-2.5 text-[13px] shadow-sm', isUser ? 'max-w-xl' : 'w-full max-w-none', bubble)}>
        {isUser ? <div className="whitespace-pre-wrap break-words">{msg.text}</div> : <MarkdownContent text={msg.text} />}
        {(msg.statusChips?.length || msg.detail) ? (
          <div className="app-message-status-bar mt-2 border-t border-white/10 pt-2 text-[11px] text-slate-300">
            {msg.statusChips?.map((chip) => (
              <span key={chip} className="app-message-status-chip inline-flex items-center rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] text-slate-300">
                {chip}
              </span>
            ))}
            {msg.detail ? <span className="text-slate-400">{msg.detail}</span> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function toolDisplayConfig(toolName: string) {
  const normalized = toolName.toLowerCase();

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

export function LiveChatTurnCard({ turn, historical = false }: { turn: DesktopChatTurnSnapshot; historical?: boolean }) {
  const hasAssistant = turn.assistantText.trim().length > 0;
  const hasThinking = turn.thinkingText.trim().length > 0;
  const showLiveStatusHeader = !historical && !turn.completed;
  const liveStatusText =
    turn.status === 'cancelling'
      ? 'Stopping…'
      : turn.status === 'retrying'
        ? 'Retrying…'
        : turn.status === 'compacting'
          ? 'Compacting…'
          : 'Working…';
  const [expandedThinking, setExpandedThinking] = useState(false);
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});

  return (
    <div className="w-full max-w-[min(100%,58rem)] space-y-1.5 pb-1.5">
      {showLiveStatusHeader ? (
        <div className="flex items-center gap-2 text-[11px] font-medium text-slate-400">
          <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          <span className="text-slate-300">{liveStatusText}</span>
        </div>
      ) : null}

      {hasThinking ? (
        <TimelineSection
          icon={Sparkles}
          title="Thinking"
          meta="Reasoning trace"
          expanded={expandedThinking}
          onToggle={() => setExpandedThinking((current) => !current)}
          badge={<span className="text-[10px] text-slate-600">{expandedThinking ? 'Hide' : 'Show'}</span>}
        >
          <div className="pr-1">
            <MarkdownContent text={turn.thinkingText} tone="muted" className="text-[12.5px] leading-[1.55rem]" />
          </div>
        </TimelineSection>
      ) : null}

      {turn.tools.map((tool) => {
        const expanded = expandedTools[tool.id] ?? !turn.completed;
        const toolDisplay = toolDisplayConfig(tool.name);

        return (
          <TimelineSection
            key={tool.id}
            icon={toolDisplay.icon}
            title={tool.name}
            meta={tool.detail ?? tool.status}
            expanded={expanded}
            onToggle={() => setExpandedTools((current) => ({ ...current, [tool.id]: !expanded }))}
            badge={
              <div
                className={cn(
                  'rounded-full border px-1.5 py-0.5 text-[8.5px] font-medium uppercase tracking-[0.08em] leading-none',
                  tool.status === 'error'
                    ? 'border-rose-400/10 bg-rose-500/6 text-rose-300/75'
                    : tool.status === 'done'
                      ? 'border-emerald-400/10 bg-emerald-500/6 text-emerald-300/75'
                      : 'border-white/8 bg-white/[0.03] text-slate-400',
                )}
              >
                {tool.status}
              </div>
            }
          >
            <div>
              {tool.arguments ? <ToolTranscriptBlock label="Arguments" icon={Braces} text={tool.arguments} language="json" maxHeightClass="max-h-56" wrapLines /> : null}
              {tool.liveOutput ? <ToolTranscriptBlock label="Live output" icon={TerminalSquare} text={tool.liveOutput} language="text" maxHeightClass="max-h-64" /> : null}
              {tool.resultText ? <ToolTranscriptBlock label="Result" icon={CheckCircle2} text={tool.resultText} language="text" maxHeightClass="max-h-72" /> : null}
            </div>
          </TimelineSection>
        );
      })}

      {hasAssistant ? (
        <div className="flex w-full flex-col items-start gap-0.5 py-0.5">
          <div className="app-chat-bubble-peer min-w-0 overflow-hidden w-full max-w-none rounded-[18px] px-3.5 py-2 text-[13px] shadow-sm">
            <MarkdownContent text={turn.assistantText} />
          </div>
        </div>
      ) : null}

      {turn.error ? (
        <div className="rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">{turn.error}</div>
      ) : null}
    </div>
  );
}

export function BridgeChip({ bridge }: { bridge: string }) {
  return <Badge variant="outline" className="app-control-chip rounded-full">{bridge}</Badge>;
}

export function ContactRow({ contact, active, onSelect }: { contact: Contact; active: boolean; onSelect: () => void }) {
  return (
    <button
      onClick={onSelect}
      className={`flex w-full items-center gap-3 rounded-2xl px-3 py-2 text-left transition ${
        active ? 'app-list-item-active text-white' : 'app-list-item text-white'
      }`}
    >
      <Avatar className="h-10 w-10 border border-white/10">
        <AvatarFallback className={active ? 'bg-slate-100 text-slate-950' : 'bg-slate-800 text-slate-100'}>{contact.initials}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{contact.name}</span>
          <span className={`text-[11px] ${active ? 'text-slate-100' : 'text-slate-300'}`}>{contact.entityType}</span>
        </div>
        <div className={`truncate text-xs ${active ? 'text-slate-100' : 'text-slate-300'}`}>{contact.subtitle}</div>
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
  request: (typeof contactRequests)[number];
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
        <Avatar className="h-10 w-10 border border-white/10">
          <AvatarFallback className={active ? 'bg-slate-100 text-slate-950' : 'bg-slate-800 text-slate-100'}>{request.initials}</AvatarFallback>
        </Avatar>
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
