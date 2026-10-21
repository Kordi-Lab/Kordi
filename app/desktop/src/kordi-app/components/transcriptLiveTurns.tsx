import { TurnProgress } from './TurnProgress';
import { useMessageLayout } from '@/app/messageLayoutPreference';
import { LiveTurnMessageFrame } from './LiveTurnMessageFrame';
import { liveTurnSnapshotKey } from '@/features/chat/liveTurnSnapshotKey';
export { liveTurnSnapshotKey } from '@/features/chat/liveTurnSnapshotKey';
import { agentTurnHasStarted, canDisplayAgentTurn, shouldShowAgentWaitingAnimation } from '@/features/chat/agentProcessingVisibility';
import { cancelledTurnContent } from '@/features/chat/cancellation';
import { memo, useEffect, useState } from 'react';
import {
  ArrowRightLeft,
  Braces,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  FileText,
  FolderOpen,
  Globe,
  Image,
  Link2,
  LoaderCircle,
  Pencil,
  Search,
  TerminalSquare,
  Wrench,
} from 'lucide-react';
import { changedFileRowsFromTurn } from '@/features/chat/artifacts';
import { useVisibleLiveTurn } from '@/features/chat/useVisibleLiveTurn';
import { cloudAgentProviderFailureNeedsAuthentication, cloudAgentProviderFailureNotice } from '@/features/cloud/cloudAgentMessages';
import { cn } from '@/lib/utils';
import { AgentWaitingWave } from './AgentWaitingWave';
import { SourceMessageQuoteRow } from './transcriptReplyAttribution';
import { MarkdownContent } from './markdown';
import { ToolTranscriptBlock } from './transcriptToolOutput';
import { FoldableAssistantAnswer } from './transcriptAssistantAnswer';
import { InlineChangedFiles } from './transcriptChangedFiles';
import {
  LEGACY_PARTICIPANT_REQUEST_TOOL_NAME,
  toolTimelineDisplayArguments,
  toolTimelineRunningToolLabel,
  toolTimelineToolLabel,
  toolTimelineTypeLabel,
} from './toolTimeline';
import type { DesktopChatTurnSnapshot, MessageSourceReference } from '../types';
import { AgentRequestHeaderStop, CollaborationAgentStopButton, TurnStopButton, type StopActiveTurnHandler, type StopCollaborationAgentRequestHandler } from './transcriptTurnStopControls';

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
    <div className="app-transcript-timeline-details" data-transcript-stable-disclosure-root="true">
      <button
        type="button"
        className="app-button-quiet app-transcript-timeline-details-toggle"
        data-transcript-stable-disclosure="true"
        onClick={() => setExpandedDetails((current) => !current)}
        aria-expanded={expandedDetails}
      >
        <ChevronRight className={cn('h-3 w-3 transition-transform', expandedDetails && 'rotate-90')} />
        <span>Details</span>
      </button>
      {expandedDetails ? (
        <div className="app-transcript-timeline-details-body" data-transcript-stable-disclosure-body="true">
          <ToolDetailBlocks tool={tool} display={display} />
        </div>
      ) : null}
    </div>
  );
}

function ToolTimelineToolRow({ tool }: { tool: ToolSnapshot }) {
  const display = toolDisplayConfig(tool.name);
  const Icon = display.icon;
  const status = statusLabelForTool(tool);
  const metaText = toolMetaText(tool);
  const running = isRunningTool(tool);
  const label = running ? toolTimelineRunningToolLabel(tool) : toolTimelineToolLabel(tool);

  return (
    <div className={cn('app-transcript-timeline-row', running && 'app-transcript-timeline-row-running')}>
      <span className="app-transcript-timeline-rail" aria-hidden="true">
        <span className="app-transcript-timeline-node">
          <Icon className="h-3.5 w-3.5" />
        </span>
      </span>
      <div
        className="app-transcript-timeline-row-body"
        aria-label={`${label}, ${status}${metaText ? `, ${metaText}` : ''}`}
      >
        <div className="app-transcript-timeline-row-line">
          <span className="app-transcript-timeline-row-title">{label}</span>
        </div>
        {isFailedTool(tool) && metaText && metaText !== status ? <div className="app-transcript-timeline-row-meta truncate">{metaText}</div> : null}
        <ToolTimelineDetails tool={tool} display={display} />
      </div>
    </div>
  );
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

function LiveChatTurnCardView({
  turn,
  historical = false,
  hideSourceQuote = false,
  showReasoning = false,
  plainAgentResponse = false,
  stopInHeader = false,
  onStopCollaborationAgentRequest,
  onStopActiveTurn,
  onNavigateToMessage,
  onOpenArtifact,
  onOpenAuthSettings,
}: {
  turn: DesktopChatTurnSnapshot;
  historical?: boolean;
  hideSourceQuote?: boolean;
  showReasoning?: boolean;
  plainAgentResponse?: boolean;
  /** The row header renders the stop control, so the card does not repeat it. */
  stopInHeader?: boolean;
  onStopCollaborationAgentRequest?: StopCollaborationAgentRequestHandler;
  onStopActiveTurn?: StopActiveTurnHandler;
  onNavigateToMessage?: (messageId: string, sourceMessage?: MessageSourceReference) => void;
  onOpenArtifact?: (artifactId: string) => void;
  onOpenAuthSettings?: () => void;
}) {
  const visibleTurn = useVisibleLiveTurn(turn, historical, showReasoning);
  // A reply that ended early keeps its partial text with a footer of how it ended.
  const ending = visibleTurn.completed && visibleTurn.assistantText.trim() ? visibleTurn.ending : undefined;
  const cancelledContent = visibleTurn.status === 'cancelled' && !ending
    ? cancelledTurnContent(visibleTurn.assistantText, visibleTurn.message, visibleTurn.error)
    : null;
  const assistantText = cancelledContent?.assistantText ?? visibleTurn.assistantText;
  // Failure transports may copy the error into assistantText. Render that
  // notice once, while preserving any partial answer before the failure.
  const assistantTextDuplicatesError = (() => {
    const text = assistantText.trim();
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
  const hasAssistant = assistantText.trim().length > 0 && !assistantTextDuplicatesError;
  const hasThinking = visibleTurn.thinkingText.trim().length > 0;
  const hasVisibleContent = hasAssistant || hasThinking || visibleTurn.tools.length > 0 || Boolean(visibleTurn.error);
  const isCompressionStatus = visibleTurn.status === 'compacting' || visibleTurn.status === 'compacted' || visibleTurn.status === 'compaction_failed';
  const shouldShowLiveStatusHeader = !historical && !visibleTurn.completed && !hasVisibleContent && !isCompressionStatus
    && (visibleTurn.status === 'queued' || agentTurnHasStarted(visibleTurn) || Boolean(visibleTurn.pendingCollaborationAgentRequest) || Boolean(visibleTurn.hostedRunStatus));
  const pendingCollaborationAgentRequest = visibleTurn.pendingCollaborationAgentRequest ?? null;
  const turnIsRunning = !historical && !visibleTurn.completed;
  const activeStopAvailable = turnIsRunning && Boolean(onStopActiveTurn) && !pendingCollaborationAgentRequest && !visibleTurn.id.startsWith('collaboration-live-turn:');
  const cardStopAvailable = activeStopAvailable && !stopInHeader;
  const cardCollaborationStop = stopInHeader ? null : pendingCollaborationAgentRequest;
  const showLiveStatusHeader = useDelayedLiveStatus(shouldShowLiveStatusHeader, visibleTurn.id)
    || Boolean(shouldShowLiveStatusHeader && (visibleTurn.status === 'queued' || pendingCollaborationAgentRequest || activeStopAvailable || visibleTurn.sourceMessage || visibleTurn.hostedRunStatus));
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
  const hasTimelineActivity = hasThinking || visibleTurn.tools.length > 0;
  const changedFileRows = changedFileRowsFromTurn(visibleTurn);
  const providerFailureNotice = visibleTurn.error ? cloudAgentProviderFailureNotice(visibleTurn.error) : null;
  const displayedError = ending ? null : providerFailureNotice ?? (cancelledContent ? cancelledContent.error : visibleTurn.error);
  const cancellationNotice = cancelledContent?.notice;
  const shouldShowSourceQuote = !plainAgentResponse && Boolean(visibleTurn.sourceMessage);
  const hasResponseSurface = Boolean( // A failed quoted turn keeps its answer surface; the quote sits below it.
    (shouldShowSourceQuote && visibleTurn.error)
      || showLiveStatusHeader
      || isCompressionStatus
      || hasTimelineActivity
      || hasAssistant
      || cancellationNotice
      || changedFileRows.length > 0,
  );
  const showResponsePanel = hasResponseSurface || Boolean(visibleTurn.error); const statusOnly = showLiveStatusHeader && !isCompressionStatus && !hasTimelineActivity && !hasAssistant && !cancellationNotice && !displayedError && changedFileRows.length === 0;
  const showOpenAuthAction = Boolean(onOpenAuthSettings && visibleTurn.error && cloudAgentProviderFailureNeedsAuthentication(visibleTurn.error));
  if (!canDisplayAgentTurn(visibleTurn)) return null;
  return (
    <div data-live-turn-status={visibleTurn.status} className="app-live-turn-card w-full max-w-[min(100%,58rem)] pb-1.5 [overflow-anchor:auto]">
      {showResponsePanel ? (
        <div data-live-turn-pending={statusOnly ? 'true' : undefined} className={cn('app-live-turn-response-panel', hasResponseSurface && !plainAgentResponse && 'app-live-assistant-answer-surface', !hasAssistant && !isCompressionStatus && changedFileRows.length === 0 ? 'w-fit' : 'w-full', 'max-w-[min(100%,58rem)] space-y-2.5')}>
          {showLiveStatusHeader ? (
            <div className="app-transcript-live-status flex items-center gap-2 text-[11px] font-medium text-slate-400">
              {visibleTurn.status === 'cancelling' || visibleTurn.status === 'retrying' ? (
                <>
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  <span className="text-slate-300">{liveStatusText}</span>
                </>
              ) : visibleTurn.status === 'queued' || visibleTurn.hostedRunStatus === 'queued' || visibleTurn.hostedRunStatus === 'leased' ? (
                <span role="status">{visibleTurn.hostedRunStatus === 'leased' ? 'Starting…' : 'Queued…'}</span>
              ) : shouldShowAgentWaitingAnimation(visibleTurn) ? (
                <AgentWaitingWave label="Waiting for agent response" />
              ) : null}
              {cardCollaborationStop ? (
                <CollaborationAgentStopButton
                  request={cardCollaborationStop}
                  onStop={onStopCollaborationAgentRequest}
                />
              ) : cardStopAvailable ? (
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

          {hasTimelineActivity || hasAssistant ? (
            <TurnProgress turn={visibleTurn}
              renderTool={tool => <ToolTimelineToolRow key={tool.id} tool={tool} />}
              trailing={cardCollaborationStop && onStopCollaborationAgentRequest ? (
                <CollaborationAgentStopButton request={cardCollaborationStop} onStop={onStopCollaborationAgentRequest} />
              ) : cardStopAvailable ? <TurnStopButton onStop={onStopActiveTurn} /> : null}
              legacyAnswer={hasAssistant ? <FoldableAssistantAnswer text={assistantText} foldable={!plainAgentResponse}
                tone={visibleTurn.status === 'cancelled' && !ending ? 'cancelled' : 'default'} /> : null}
            />
          ) : null}
          {ending && hasAssistant ? (
            <div data-reply-ending={ending} className="app-message-footer app-live-turn-ending px-0.5 text-[11px] leading-4">
              {ending === 'stopped' ? 'Stopped' : 'Interrupted'}
            </div>
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
      {shouldShowSourceQuote && !hideSourceQuote ? <SourceMessageQuoteRow sourceMessage={visibleTurn.sourceMessage} side="agent" onNavigateToMessage={onNavigateToMessage} className={showResponsePanel ? 'mt-1' : undefined} /> : null}
    </div>
  );
}


export const LiveChatTurnCard = memo(
  LiveChatTurnCardView,
  (previous, next) => previous.historical === next.historical
    && previous.hideSourceQuote === next.hideSourceQuote
    && previous.showReasoning === next.showReasoning
    && previous.plainAgentResponse === next.plainAgentResponse
    && previous.stopInHeader === next.stopInHeader
    && previous.onStopCollaborationAgentRequest === next.onStopCollaborationAgentRequest
    && previous.onStopActiveTurn === next.onStopActiveTurn
    && previous.onNavigateToMessage === next.onNavigateToMessage
    && previous.onOpenArtifact === next.onOpenArtifact
    && previous.onOpenAuthSettings === next.onOpenAuthSettings
    && (previous.turn === next.turn || liveTurnSnapshotKey(previous.turn) === liveTurnSnapshotKey(next.turn)),
);

function LiveChatTurnMessageView({
  turn,
  sender = 'Kordi',
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
  const threadLayout = useMessageLayout() === 'threads';
  const card = (
    <LiveChatTurnCard
      turn={turn}
      hideSourceQuote={threadLayout}
      showReasoning
      plainAgentResponse={plainAgentResponse}
      stopInHeader
      onStopCollaborationAgentRequest={onStopCollaborationAgentRequest}
      onStopActiveTurn={onStopActiveTurn}
      onNavigateToMessage={onNavigateToMessage}
      onOpenArtifact={onOpenArtifact}
      onOpenAuthSettings={onOpenAuthSettings}
    />
  );
  const headerStop = (
    <AgentRequestHeaderStop
      turn={turn}
      onStopActiveTurn={onStopActiveTurn}
      onStopCollaborationAgentRequest={onStopCollaborationAgentRequest}
    />
  );
  return <LiveTurnMessageFrame turn={turn} sender={sender} showSourceQuote={!plainAgentResponse} onNavigateToMessage={onNavigateToMessage} headerAccessory={headerStop}>{card}</LiveTurnMessageFrame>;
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
