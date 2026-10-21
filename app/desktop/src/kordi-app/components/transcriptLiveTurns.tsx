import { ToolActivityRow } from './ToolActivityRow';
import { TurnProgress } from './TurnProgress';
import { useMessageLayout } from '@/app/messageLayoutPreference';
import { LiveTurnMessageFrame } from './LiveTurnMessageFrame';
import { liveTurnSnapshotKey } from '@/features/chat/liveTurnSnapshotKey';
export { liveTurnSnapshotKey } from '@/features/chat/liveTurnSnapshotKey';
import { agentTurnHasStarted, canDisplayAgentTurn, shouldShowAgentWaitingAnimation } from '@/features/chat/agentProcessingVisibility';
import { cancelledTurnContent } from '@/features/chat/cancellation';
import { memo, useEffect, useState } from 'react';
import {
  CheckCircle2,
  CircleAlert,
  LoaderCircle,
} from 'lucide-react';
import { changedFileRowsFromTurn } from '@/features/chat/artifacts';
import { useVisibleLiveTurn } from '@/features/chat/useVisibleLiveTurn';
import { cloudAgentProviderFailureNeedsAuthentication, cloudAgentProviderFailureNotice } from '@/features/cloud/cloudAgentMessages';
import { cn } from '@/lib/utils';
import { AgentWaitingWave } from './AgentWaitingWave';
import { SourceMessageQuoteRow } from './transcriptReplyAttribution';
import { MarkdownContent } from './markdown';
import { FoldableAssistantAnswer } from './transcriptAssistantAnswer';
import { InlineChangedFiles } from './transcriptChangedFiles';
import {
  toolTimelineTypeLabel,
} from './toolTimeline';
import type { DesktopChatTurnSnapshot, MessageSourceReference } from '../types';
import { AgentRequestHeaderStop, CollaborationAgentStopButton, TurnStopButton, type StopActiveTurnHandler, type StopCollaborationAgentRequestHandler } from './transcriptTurnStopControls';

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
        <div data-live-turn-pending={statusOnly ? 'true' : undefined} className={cn('app-live-turn-response-panel', visibleTurn.segments?.length ? 'app-ordered-turn-surface' : hasResponseSurface && !plainAgentResponse && 'app-live-assistant-answer-surface', !visibleTurn.segments?.length && !hasAssistant && !isCompressionStatus && changedFileRows.length === 0 ? 'w-fit' : 'w-full', 'max-w-[min(100%,58rem)] space-y-2.5')}>
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
              renderTool={tool => <ToolActivityRow key={tool.id} tool={tool} onOpenFile={onOpenArtifact} />}
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
