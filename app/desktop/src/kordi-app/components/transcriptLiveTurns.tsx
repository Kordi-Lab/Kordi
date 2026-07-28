import { memo, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import {
  ArrowRightLeft,
  Braces,
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
  Square,
  TerminalSquare,
  WrapText,
  Wrench,
} from 'lucide-react';

import { changedFileRowsFromTurn } from '@/features/chat/artifacts';
import { cloudAgentNoProviderNoticeText, isCloudAgentNoProviderConfiguredError } from '@/features/cloud/cloudAgentMessages';
import { cn } from '@/lib/utils';
import { isDiffLikeOutput, parseDiffOutput, stripAnsi, type ParsedDiffLine } from './diffOutput';
import { SourceMessageQuote, transcriptMessageDomId } from './transcriptReplyAttribution';
import { MarkdownCodeBlock, MarkdownContent } from './markdown';
import { InlineChangedFiles } from './transcriptChangedFiles';
import {
  firstMeaningfulThinkingLine,
  formatRunningElapsed,
  LEGACY_PARTICIPANT_REQUEST_TOOL_NAME,
  toolTimelineDisplayArguments,
  toolTimelineFailureLabel,
  toolTimelineFoldedLabel,
  toolTimelineLayerGroups,
  toolTimelineRunningToolLabel,
  toolTimelineToolLabel,
  toolTimelineTypeLabel,
  type ToolTimelineLayerGroup,
} from './toolTimeline';
import type { CollaborationAgentRequestControl, DesktopChatTurnSnapshot, MessageSourceReference } from '../types';

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
            aria-label={isWrapped ? 'Disable line wrapping' : 'Wrap long lines'}
            title={isWrapped ? 'Disable line wrapping' : 'Wrap long lines'}
            onClick={() => setIsWrapped((current) => !current)}
            className="app-transcript-wrap-toggle inline-flex h-6 w-6 items-center justify-center rounded-md bg-white/5 text-slate-300 transition hover:bg-white/10 hover:text-white"
          >
            <WrapText className="h-3 w-3" aria-hidden="true" />
          </button>
        }
      />
    </div>
  );
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

function toolDisplayConfig(toolName: string) {
  const normalized = toolName.toLowerCase();

  if (normalized === LEGACY_PARTICIPANT_REQUEST_TOOL_NAME) {
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
      {tool.arguments ? <ToolTranscriptBlock label={display.argumentsLabel ?? 'Arguments'} icon={Braces} text={toolTimelineDisplayArguments(tool)} language="json" maxHeightClass="max-h-56" wrapLines /> : null}
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
                <MarkdownContent text={thinkingText} tone="muted" className="app-transcript-thinking-markdown text-[12px] leading-[1.55rem]" />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function useRunningElapsedLabel(running: boolean, resetKey?: string | null) {
  const key = resetKey ?? '';
  const startedAtRef = useRef<number | null>(running ? Date.now() : null);
  const runningKeyRef = useRef(key);
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (!running) {
      startedAtRef.current = null;
      runningKeyRef.current = key;
      setElapsedMs(0);
      return undefined;
    }

    if (startedAtRef.current === null || runningKeyRef.current !== key) {
      startedAtRef.current = Date.now();
      runningKeyRef.current = key;
      setElapsedMs(0);
    }

    const updateElapsed = () => setElapsedMs(Date.now() - (startedAtRef.current ?? Date.now()));
    updateElapsed();
    const interval = window.setInterval(updateElapsed, 1_000);
    return () => window.clearInterval(interval);
  }, [key, running]);

  return running ? formatRunningElapsed(elapsedMs) : null;
}

function toolGroupIcon(label: string) {
  switch (label) {
    case 'Observation':
      return FileText;
    case 'Planning':
    case 'Operator':
      return Wrench;
    case 'Execution':
      return TerminalSquare;
    case 'Reflection':
      return CheckCircle2;
    default:
      return Wrench;
  }
}

function toolGroupSummary(tools: ToolSnapshot[]) {
  const labels: string[] = [];
  for (const tool of tools) {
    const label = toolTimelineToolLabel(tool);
    if (!labels.includes(label)) labels.push(label);
  }
  const visibleLabels = labels.slice(0, 3).join(' · ');
  const remaining = labels.length - 3;
  return remaining > 0 ? `${visibleLabels} · ${remaining} more` : visibleLabels;
}

function ToolTimelineToolGroupRow({ group }: { group: ToolTimelineLayerGroup<ToolSnapshot> }) {
  const [expandedGroup, setExpandedGroup] = useState(false);
  const Icon = toolGroupIcon(group.label);
  const title = `${group.label} × ${group.tools.length}`;
  const summary = toolGroupSummary(group.tools);

  return (
    <div className={cn('app-transcript-timeline-row app-transcript-timeline-group-row', group.running && 'app-transcript-timeline-row-running', group.failed && 'app-transcript-timeline-row-error')}>
      <span className="app-transcript-timeline-rail" aria-hidden="true">
        <span className="app-transcript-timeline-node">
          <Icon className="h-3.5 w-3.5" />
        </span>
      </span>
      <div className="app-transcript-timeline-row-body">
        <button
          type="button"
          className="app-transcript-timeline-group-summary"
          onClick={() => setExpandedGroup((current) => !current)}
          aria-expanded={expandedGroup}
        >
          <span className="app-transcript-timeline-row-title">{title}</span>
          <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform', expandedGroup && 'rotate-90')} aria-hidden="true" />
        </button>
        {summary ? <div className="app-transcript-timeline-row-meta truncate">{summary}</div> : null}
        {expandedGroup ? (
          <div className="app-transcript-timeline-group-tools">
            {group.tools.map((tool) => <ToolTimelineToolRow key={tool.id} tool={tool} />)}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ToolTimelineToolRow({ tool }: { tool: ToolSnapshot }) {
  const display = toolDisplayConfig(tool.name);
  const Icon = display.icon;
  const status = statusLabelForTool(tool);
  const metaText = toolMetaText(tool);
  const running = isRunningTool(tool);
  const typeLabel = toolTimelineTypeLabel(tool);
  const label = running ? toolTimelineRunningToolLabel(tool) : toolTimelineToolLabel(tool);
  const runningElapsed = useRunningElapsedLabel(running, tool.id);

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

function ToolTimelineCompletionRow({ failedCount }: { failedCount: number }) {
  const failed = failedCount > 0;
  return (
    <div className={cn('app-transcript-timeline-row app-transcript-timeline-row-complete', failed && 'app-transcript-timeline-row-error')}>
      <span className="app-transcript-timeline-rail" aria-hidden="true">
        <span className="app-transcript-timeline-node">
          {failed ? <CircleAlert className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
        </span>
      </span>
      <div className="app-transcript-timeline-row-body">
        <div className="app-transcript-timeline-row-line">
          <span className="app-transcript-timeline-row-title">{failed ? toolTimelineFailureLabel(failedCount) : 'Done'}</span>
          {failed ? null : <span className="app-transcript-timeline-pill">Complete</span>}
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
  trailing,
}: {
  tools: ToolSnapshot[];
  thinkingText: string;
  active: boolean;
  completed: boolean;
  trailing?: ReactNode;
}) {
  const [expandedTimeline, setExpandedTimeline] = useState(false);
  const hasThinking = thinkingText.trim().length > 0;
  const failedCount = tools.filter(isFailedTool).length;
  const failed = failedCount > 0;
  const runningTool = tools.find(isRunningTool);
  const runningElapsed = useRunningElapsedLabel(Boolean(runningTool), runningTool?.id ?? null);
  const summary = toolTimelineFoldedLabel({ tools, active, completed, thinkingText, runningElapsed });

  if (!hasThinking && tools.length === 0) return null;

  return (
    <section className={cn('app-transcript-tool-timeline', active && 'app-transcript-tool-timeline-active')}>
      <div className="app-transcript-tool-timeline-row flex w-full items-center gap-2">
        <button
          type="button"
          className={cn('app-transcript-tool-timeline-summary min-w-0 flex-1', active && 'app-transcript-tool-timeline-summary-active')}
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
        {trailing ? <div className="shrink-0">{trailing}</div> : null}
      </div>

      {expandedTimeline ? (
        <div className="app-transcript-timeline-list">
          {hasThinking ? <ToolTimelineThinkingRow thinkingText={thinkingText} /> : null}
          {toolTimelineLayerGroups(tools).map((group) => <ToolTimelineToolGroupRow key={group.id} group={group} />)}
          {completed || failed ? <ToolTimelineCompletionRow failedCount={failedCount} /> : null}
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
    artifactPath: next.artifactPath || current.artifactPath,
    toolLayer: next.toolLayer || current.toolLayer,
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

export type StopCollaborationAgentRequestHandler = (request: CollaborationAgentRequestControl) => Promise<void> | void;
export type StopActiveTurnHandler = () => Promise<void> | void;

const GENERIC_LIVE_STATUS_MESSAGES = new Set(['working…', 'running tool…']);

function normalizedLiveStatusMessage(value: string) {
  return value.trim().toLowerCase().replace(/\.\.\.$/, '…');
}

function liveStatusMessageIsGeneric(value: string) {
  return GENERIC_LIVE_STATUS_MESSAGES.has(normalizedLiveStatusMessage(value));
}

function toolStatusIsComplete(status: string) {
  const normalized = status.trim().toLowerCase();
  return normalized === 'done' || normalized === 'complete' || normalized === 'completed';
}

function toolStatusIsFailed(status: string, isError: boolean) {
  const normalized = status.trim().toLowerCase();
  return isError || normalized === 'error' || normalized.includes('failed');
}

function livePhaseLabelFromTool(tool: DesktopChatTurnSnapshot['tools'][number]) {
  switch (toolTimelineTypeLabel(tool)) {
    case 'Observation':
      return 'Observation…';
    case 'Planning':
      return 'Planning…';
    case 'Operator':
      return 'Coordination…';
    case 'Execution':
      return 'Execution…';
    case 'Reflection':
      return 'Reflection…';
    default:
      return null;
  }
}

function liveTurnPhaseStatusText(turn: DesktopChatTurnSnapshot) {
  const explicitMessage = turn.message?.trim() ?? '';
  if (explicitMessage && !liveStatusMessageIsGeneric(explicitMessage)) return explicitMessage;

  const activeTool = [...turn.tools].reverse().find((tool) => !toolStatusIsComplete(tool.status) && !toolStatusIsFailed(tool.status, tool.isError));
  const activePhase = activeTool ? livePhaseLabelFromTool(activeTool) : null;
  if (activePhase) return activePhase;

  const latestTool = [...turn.tools].reverse().find((tool) => !toolStatusIsFailed(tool.status, tool.isError));
  const latestPhase = latestTool ? livePhaseLabelFromTool(latestTool) : null;
  if (latestPhase) return latestPhase;

  if (turn.status === 'starting') return 'Starting…';
  return 'Thinking…';
}

function TurnStopButton({
  onStop,
  ariaLabel = 'Stop agent request',
  stoppingLabel = 'Stopping agent request',
}: {
  onStop?: StopActiveTurnHandler;
  ariaLabel?: string;
  stoppingLabel?: string;
}) {
  const [stopping, setStopping] = useState(false);
  if (!onStop) return null;

  return (
    <button
      type="button"
      className="app-collaboration-agent-stop-button inline-grid h-[18px] w-[18px] place-items-center rounded-full border border-slate-500/25 bg-slate-800/30 text-slate-400 transition hover:border-rose-300/40 hover:bg-rose-400/[0.08] hover:text-rose-200 disabled:cursor-not-allowed disabled:opacity-55"
      aria-label={stopping ? stoppingLabel : ariaLabel}
      title={stopping ? 'Stopping…' : ariaLabel}
      disabled={stopping}
      onClick={(event) => {
        event.stopPropagation();
        event.preventDefault();
        setStopping(true);
        void Promise.resolve(onStop()).catch(() => {
          setStopping(false);
        });
      }}
    >
      <Square className="h-2 w-2 fill-current" aria-hidden="true" />
    </button>
  );
}

function CollaborationAgentStopButton({
  request,
  onStop,
}: {
  request: CollaborationAgentRequestControl;
  onStop?: StopCollaborationAgentRequestHandler;
}) {
  if (!onStop) return null;
  return <TurnStopButton onStop={() => onStop(request)} />;
}

const ASSISTANT_ANSWER_FOLDED_VISIBLE_LINES = 6;

function assistantAnswerFoldInfo(text: string) {
  const lines = text.split(/\r?\n/);
  const hiddenLineCount = Math.max(0, lines.length - ASSISTANT_ANSWER_FOLDED_VISIBLE_LINES);
  const shouldFold = hiddenLineCount > 0 || text.replace(/\s+/g, ' ').trim().length > 720;
  return { shouldFold, hiddenLineCount };
}

function foldedAssistantAnswerToggleLabel(hiddenLineCount: number) {
  if (hiddenLineCount > 0) {
    return `Show ${hiddenLineCount} more line${hiddenLineCount === 1 ? '' : 's'}`;
  }
  return 'Show full response';
}

function FoldableAssistantAnswer({
  text,
  foldable = true,
  tone = 'default',
}: {
  text: string;
  foldable?: boolean;
  tone?: 'default' | 'cancelled';
}) {
  const [expanded, setExpanded] = useState(false);
  const foldInfo = useMemo(() => assistantAnswerFoldInfo(text), [text]);
  const shouldFold = foldable && foldInfo.shouldFold;
  const folded = shouldFold && !expanded;
  const cancelled = tone === 'cancelled';

  return (
    <div className={cn(
      'app-live-assistant-answer w-full text-[13px]',
      cancelled && 'app-live-assistant-answer-cancelled text-rose-300',
    )}>
      <div className={cn('app-live-assistant-answer-content', folded && 'app-live-assistant-answer-folded')}>
        <MarkdownContent
          text={text}
          className={cn(
            'app-live-assistant-answer-markdown',
            cancelled && '[&_p]:!text-rose-300 [&_li]:!text-rose-300 [&_blockquote]:!text-rose-300',
          )}
        />
      </div>
      {shouldFold ? (
        <div className="app-fold-reveal-row app-live-assistant-answer-reveal-row">
          <button
            type="button"
            className="app-inline-expand-toggle app-live-assistant-answer-toggle"
            onClick={() => setExpanded((current) => !current)}
            aria-expanded={expanded}
          >
            <span>{folded ? foldedAssistantAnswerToggleLabel(foldInfo.hiddenLineCount) : 'Hide response'}</span>
            {folded ? <ChevronDown className="app-inline-expand-toggle-icon" aria-hidden="true" /> : <ChevronUp className="app-inline-expand-toggle-icon" aria-hidden="true" />}
          </button>
          <span className="app-fold-reveal-line" aria-hidden="true" />
        </div>
      ) : null}
    </div>
  );
}

function LiveChatTurnCardView({
  turn,
  historical = false,
  plainAgentResponse = false,
  onStopCollaborationAgentRequest,
  onStopActiveTurn,
  onNavigateToMessage,
  onOpenArtifact,
  onOpenAuthSettings,
}: {
  turn: DesktopChatTurnSnapshot;
  historical?: boolean;
  plainAgentResponse?: boolean;
  onStopCollaborationAgentRequest?: StopCollaborationAgentRequestHandler;
  onStopActiveTurn?: StopActiveTurnHandler;
  onNavigateToMessage?: (messageId: string, sourceMessage?: MessageSourceReference) => void;
  onOpenArtifact?: (artifactId: string) => void;
  onOpenAuthSettings?: () => void;
}) {
  const visibleTurn = useVisibleLiveTurn(turn, historical);
  // Suppress assistantText when it's just a "Failed: <error>" or duplicate of
  // visibleTurn.error so the failure surface shows the red error line once,
  // not twice. Wrappers like cloud-agent response writer at
  // useCloudCollaborationState.ts:1169 store the failure as `Failed: ${error}` in
  // canonical contentText; the read model surfaces that as assistantText, and
  // the error field already carries the same message — rendering both is
  // visually redundant. Retain assistantText whenever it contains additional
  // content beyond the error (partial streamed reply before the failure).
  const assistantTextDuplicatesError = (() => {
    const text = visibleTurn.assistantText.trim();
    const error = visibleTurn.error?.trim();
    if (!text || !error) return false;
    if (text === error) return true;
    if (text === `Failed: ${error}`) return true;
    // Near-duplicate: assistantText ends with the error and the prefix is a
    // short status-like wrapper (e.g. "Failed: ", "Error: ", language variants).
    // 24 chars is enough to cover any reasonable failure prefix without
    // swallowing legitimately different streamed content.
    if (text.endsWith(error) && text.length - error.length <= 24) return true;
    return false;
  })();
  const hasAssistant = visibleTurn.assistantText.trim().length > 0 && !assistantTextDuplicatesError;
  const hasThinking = visibleTurn.thinkingText.trim().length > 0;
  const hasVisibleContent = hasAssistant || hasThinking || visibleTurn.tools.length > 0 || Boolean(visibleTurn.error);
  const isCompressionStatus = visibleTurn.status === 'compacting' || visibleTurn.status === 'compacted' || visibleTurn.status === 'compaction_failed';
  const shouldShowLiveStatusHeader = !historical && !visibleTurn.completed && !hasVisibleContent && !isCompressionStatus;
  const pendingCollaborationAgentRequest = visibleTurn.pendingCollaborationAgentRequest ?? null;
  const turnIsRunning = !historical && !visibleTurn.completed;
  const activeStopAvailable = turnIsRunning && Boolean(onStopActiveTurn) && !pendingCollaborationAgentRequest;
  const showLiveStatusHeader = useDelayedLiveStatus(shouldShowLiveStatusHeader, visibleTurn.id)
    || Boolean(shouldShowLiveStatusHeader && (pendingCollaborationAgentRequest || activeStopAvailable || visibleTurn.sourceMessage));
  const liveStatusText = visibleTurn.status === 'cancelling'
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
                : liveTurnPhaseStatusText(visibleTurn);
  const liveTurnActive = !historical && !visibleTurn.completed;
  const hasTimelineActivity = hasThinking || visibleTurn.tools.length > 0;
  const changedFileRows = changedFileRowsFromTurn(visibleTurn);
  const noProviderConfiguredError = Boolean(visibleTurn.error && isCloudAgentNoProviderConfiguredError(visibleTurn.error));
  const displayedError = noProviderConfiguredError ? cloudAgentNoProviderNoticeText() : visibleTurn.error;
  const cancellationNotice = visibleTurn.status === 'cancelled'
    ? (visibleTurn.message.trim() || 'Response stopped')
    : null;
  const shouldShowSourceQuote = Boolean(visibleTurn.sourceMessage);
  const hasResponseSurface = Boolean(
    shouldShowSourceQuote
      || showLiveStatusHeader
      || isCompressionStatus
      || hasTimelineActivity
      || hasAssistant
      || cancellationNotice
      || changedFileRows.length > 0,
  );
  const showResponsePanel = hasResponseSurface || Boolean(visibleTurn.error);
  const showOpenAuthAction = Boolean(onOpenAuthSettings && noProviderConfiguredError);

  return (
    <div className="app-live-turn-card w-full max-w-[min(100%,58rem)] pb-1.5 [overflow-anchor:auto]">
      {showResponsePanel ? (
        <div className={cn('app-live-turn-response-panel', hasResponseSurface && !plainAgentResponse && 'app-live-assistant-answer-surface', 'w-full max-w-[min(100%,42rem)] space-y-2.5')}>
          {shouldShowSourceQuote ? (
            <SourceMessageQuote sourceMessage={visibleTurn.sourceMessage} onNavigateToMessage={onNavigateToMessage} />
          ) : null}
          {showLiveStatusHeader ? (
            <div className="app-transcript-live-status flex items-center gap-2 text-[11px] font-medium text-slate-400">
              <ProcessingStatusCircle className="h-3.5 w-3.5" />
              <span className="text-slate-300">{liveStatusText}</span>
              {pendingCollaborationAgentRequest ? (
                <CollaborationAgentStopButton
                  request={pendingCollaborationAgentRequest}
                  onStop={onStopCollaborationAgentRequest}
                />
              ) : activeStopAvailable ? (
                <TurnStopButton onStop={onStopActiveTurn} />
              ) : null}
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
          trailing={pendingCollaborationAgentRequest && onStopCollaborationAgentRequest ? (
            <CollaborationAgentStopButton
              request={pendingCollaborationAgentRequest}
              onStop={onStopCollaborationAgentRequest}
            />
          ) : activeStopAvailable ? (
            <TurnStopButton onStop={onStopActiveTurn} />
          ) : null}
        />
      ) : null}

          {hasAssistant ? (
            <FoldableAssistantAnswer
              text={visibleTurn.assistantText}
              foldable={!plainAgentResponse}
              tone={visibleTurn.status === 'cancelled' ? 'cancelled' : 'default'}
            />
          ) : null}

          {cancellationNotice ? (
            <div className="app-live-turn-cancelled px-0.5 text-[12px] font-medium leading-5 text-[color:var(--utility-muted-text)]">
              {cancellationNotice}
            </div>
          ) : null}

          {displayedError ? (
            <div className="app-live-turn-error app-live-turn-error-text max-w-full break-words px-0.5 text-[12px] font-medium leading-5 text-rose-300 [&_.app-live-turn-auth-action]:whitespace-nowrap">
              {displayedError}
              {showOpenAuthAction ? (
                <button
                  type="button"
                  className="app-live-turn-auth-action ml-2 inline-flex p-0 text-[12px] font-semibold text-rose-100 underline decoration-rose-200/45 underline-offset-2 transition hover:text-rose-50 hover:decoration-rose-100"
                  onClick={onOpenAuthSettings}
                >
                  Open authentication
                </button>
              ) : null}
            </div>
          ) : null}

          <InlineChangedFiles
            rows={changedFileRows}
            incomplete={visibleTurn.completed && !visibleTurn.succeeded}
            onOpenArtifact={onOpenArtifact}
          />
        </div>
      ) : null}
    </div>
  );
}

export function liveTurnSnapshotKey(turn: DesktopChatTurnSnapshot) {
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
    turn.replyToMessageId ?? '',
    turn.sourceMessage ? [turn.sourceMessage.messageId, turn.sourceMessage.text, turn.sourceMessage.senderLabel ?? ''].join(':') : '',
    turn.pendingCollaborationAgentRequest?.conversationId ?? '',
    turn.pendingCollaborationAgentRequest?.requestId ?? '',
    ...turn.tools.map((tool) => [
      tool.id,
      tool.name,
      tool.status,
      tool.arguments,
      tool.liveOutput,
      tool.resultText ?? '',
      tool.detail ?? '',
      tool.artifactPath ?? '',
      tool.toolLayer ?? '',
      tool.isError ? 'error' : 'ok',
    ].join('\u0000')),
  ].join('\u0001');
}

export const LiveChatTurnCard = memo(
  LiveChatTurnCardView,
  (previous, next) => previous.historical === next.historical
    && previous.plainAgentResponse === next.plainAgentResponse
    && previous.onStopCollaborationAgentRequest === next.onStopCollaborationAgentRequest
    && previous.onStopActiveTurn === next.onStopActiveTurn
    && previous.onNavigateToMessage === next.onNavigateToMessage
    && previous.onOpenArtifact === next.onOpenArtifact
    && previous.onOpenAuthSettings === next.onOpenAuthSettings
    && (previous.turn === next.turn || liveTurnSnapshotKey(previous.turn) === liveTurnSnapshotKey(next.turn)),
);

function LiveChatTurnMessageView({
  turn,
  sender = 'My Kordi',
  plainAgentResponse = false,
  onStopCollaborationAgentRequest,
  onStopActiveTurn,
  onNavigateToMessage,
  onOpenArtifact,
  onOpenAuthSettings,
}: {
  turn: DesktopChatTurnSnapshot;
  sender?: string;
  plainAgentResponse?: boolean;
  onStopCollaborationAgentRequest?: StopCollaborationAgentRequestHandler;
  onStopActiveTurn?: StopActiveTurnHandler;
  onNavigateToMessage?: (messageId: string, sourceMessage?: MessageSourceReference) => void;
  onOpenArtifact?: (artifactId: string) => void;
  onOpenAuthSettings?: () => void;
}) {
  return (
    <div
      id={turn.id ? transcriptMessageDomId(turn.id) : undefined}
      data-transcript-message-root="true"
      className="flex w-full max-w-[min(100%,58rem)] flex-col items-start gap-0.5 py-0.5"
    >
      <div className="app-message-meta">{sender}</div>
      <LiveChatTurnCard
        turn={turn}
        plainAgentResponse={plainAgentResponse}
        onStopCollaborationAgentRequest={onStopCollaborationAgentRequest}
        onStopActiveTurn={onStopActiveTurn}
        onNavigateToMessage={onNavigateToMessage}
        onOpenArtifact={onOpenArtifact}
        onOpenAuthSettings={onOpenAuthSettings}
      />
    </div>
  );
}

export const LiveChatTurnMessage = memo(
  LiveChatTurnMessageView,
  (previous, next) => previous.sender === next.sender
    && previous.plainAgentResponse === next.plainAgentResponse
    && previous.onStopCollaborationAgentRequest === next.onStopCollaborationAgentRequest
    && previous.onStopActiveTurn === next.onStopActiveTurn
    && previous.onNavigateToMessage === next.onNavigateToMessage
    && previous.onOpenArtifact === next.onOpenArtifact
    && previous.onOpenAuthSettings === next.onOpenAuthSettings
    && (previous.turn === next.turn || liveTurnSnapshotKey(previous.turn) === liveTurnSnapshotKey(next.turn)),
);
