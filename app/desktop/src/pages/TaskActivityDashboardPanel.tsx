import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { CheckCircle2, Circle, CornerDownLeft, FileText, XCircle } from 'lucide-react';
import { navigateToTranscriptMessage } from '@/kordi-app/components/transcriptReplyAttribution';
import type { DesktopChatTurnSnapshot, Message, SessionArtifact } from '@/kordi-app/types';
import { buildTaskActivityDashboard, type TaskDashboardItem, type TaskDashboardSubtask, type TaskDashboardTone } from '@/features/chat/taskActivityDashboard';
import { cn } from '@/lib/utils';

type TaskActivityDashboardPanelProps = {
  messages: Message[];
  liveTurn?: DesktopChatTurnSnapshot | null;
  emptyMessage: string;
  artifacts?: SessionArtifact[];
  onOpenArtifact?: (artifactId: string) => void;
  onNavigateToResponse?: (messageId: string) => void;
};

function statusDotClass(tone: TaskDashboardTone) {
  switch (tone) {
    case 'running':
      return 'bg-[color:var(--app-tool-running-fg)]';
    case 'success':
      return 'bg-emerald-400/80';
    case 'closed':
      return 'bg-slate-400/70';
    case 'error':
      return 'bg-rose-400/80';
    case 'muted':
    default:
      return 'bg-violet-300/70';
  }
}

function statusCheckboxClass(tone: TaskDashboardTone) {
  switch (tone) {
    case 'running':
      return 'text-[color:var(--app-tool-running-fg)]';
    case 'success':
      return 'text-emerald-400/90';
    case 'closed':
      return 'text-slate-400/80';
    case 'error':
      return 'text-rose-400/90';
    case 'muted':
    default:
      return 'text-violet-300/85';
  }
}

function TaskStatusIcon({ task, nested }: { task: TaskDashboardItem | TaskDashboardSubtask; nested: boolean }) {
  if (nested) {
    return <span data-subtask-status-icon="circle" className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', statusDotClass(task.tone))} />;
  }

  const iconClassName = cn('mt-0.5 h-4 w-4 shrink-0', statusCheckboxClass(task.tone));
  if (task.status === 'completed' || task.status === 'closed') {
    return <CheckCircle2 data-task-status-icon="checkbox" className={iconClassName} aria-hidden="true" />;
  }
  if (task.status === 'failed') {
    return <XCircle data-task-status-icon="checkbox" className={iconClassName} aria-hidden="true" />;
  }
  return <Circle data-task-status-icon="checkbox" className={iconClassName} aria-hidden="true" />;
}

function formatTaskElapsed(elapsedMs: number) {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

function useRunningElapsedLabel(running: boolean, resetKey?: string | null, startedAtMs?: number | null) {
  const key = resetKey ?? '';
  const startedAtRef = useRef<number | null>(running ? (startedAtMs ?? Date.now()) : null);
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
      startedAtRef.current = startedAtMs ?? Date.now();
      runningKeyRef.current = key;
      setElapsedMs(0);
    }

    const updateElapsed = () => setElapsedMs(Date.now() - (startedAtRef.current ?? Date.now()));
    updateElapsed();
    const interval = window.setInterval(updateElapsed, 1_000);
    return () => window.clearInterval(interval);
  }, [key, running, startedAtMs]);

  return running ? formatTaskElapsed(elapsedMs) : null;
}

function TaskActions({
  responseMessageId,
  artifactId,
  onOpenArtifact,
  onNavigateToResponse,
}: {
  responseMessageId?: string | null;
  artifactId?: string | null;
  onOpenArtifact?: (artifactId: string) => void;
  onNavigateToResponse?: (messageId: string) => void;
}) {
  const jumpToResponse = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!responseMessageId) return;
    if (onNavigateToResponse) {
      onNavigateToResponse(responseMessageId);
      return;
    }
    navigateToTranscriptMessage(responseMessageId);
  };
  const openArtifact = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!artifactId) return;
    onOpenArtifact?.(artifactId);
  };

  if (!responseMessageId && !artifactId) return null;

  return (
    <div className="flex shrink-0 items-center gap-1">
      {responseMessageId ? (
        <button
          type="button"
          data-task-action="jump-response"
          onClick={jumpToResponse}
          className="grid h-7 w-7 place-items-center rounded-lg border border-[color:var(--app-divider)] bg-white/[0.03] text-[color:var(--utility-muted-text)] transition hover:border-[color:var(--utility-muted-text)] hover:text-[color:var(--utility-foreground)]"
          aria-label="Jump to related response"
          title="Jump to related response"
        >
          <CornerDownLeft className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      ) : null}
      {artifactId ? (
        <button
          type="button"
          data-task-action="open-artifact"
          onClick={openArtifact}
          className="grid h-7 w-7 place-items-center rounded-lg border border-emerald-300/20 bg-emerald-300/10 text-emerald-100 transition hover:border-emerald-200/40 hover:bg-emerald-300/15"
          aria-label="Open related artifact"
          title="Open related artifact"
        >
          <FileText className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

function TaskContent({
  task,
  nested = false,
  artifactId,
  onOpenArtifact,
  onNavigateToResponse,
}: {
  task: TaskDashboardItem | TaskDashboardSubtask;
  nested?: boolean;
  artifactId?: string | null;
  onOpenArtifact?: (artifactId: string) => void;
  onNavigateToResponse?: (messageId: string) => void;
}) {
  const rawSecondaryText = task.summary || task.target || (nested ? 'No subtask details yet.' : 'Task is running.');
  const genericCompletedSummary = /^(?:complete|completed|response complete|done)$/i.test(rawSecondaryText.trim());
  const secondaryText = task.status === 'completed' && genericCompletedSummary ? '' : rawSecondaryText;
  const runningElapsed = useRunningElapsedLabel(task.status === 'active', task.id, task.startedAtMs);
  const subtaskCount = 'subtaskCount' in task ? task.subtaskCount : 0;
  const activeSubtaskCount = 'activeSubtaskCount' in task ? task.activeSubtaskCount : 0;
  const rawSubtaskLabel = subtaskCount > 0
    ? activeSubtaskCount > 0
      ? `${activeSubtaskCount} active subtask${activeSubtaskCount === 1 ? '' : 's'}`
      : `${subtaskCount} subtask${subtaskCount === 1 ? '' : 's'}`
    : null;
  const subtaskLabel = rawSubtaskLabel && rawSubtaskLabel !== secondaryText ? rawSubtaskLabel : null;
  const durationText = task.status === 'completed' || task.status === 'closed'
    ? null
    : task.durationLabel ?? (runningElapsed ? `Running · ${runningElapsed}` : null);
  const timeParts = [task.timeLabel, durationText].filter((part): part is string => Boolean(part));

  return (
    <div className={cn('flex min-w-0 items-start gap-3', nested && 'gap-2.5')}>
      <TaskStatusIcon task={task} nested={nested} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <div className={cn('app-inspector-heading whitespace-normal break-words leading-5', nested && 'text-[12px] leading-4')}>{task.title}</div>
            {secondaryText ? <div className="mt-1 app-inspector-text-block">{secondaryText}</div> : null}
            {timeParts.length > 0 ? <div className="mt-1 text-[11px] text-[color:var(--utility-muted-text)]">{timeParts.join(' · ')}</div> : null}
            {subtaskLabel ? <div className="mt-1 text-[11px] text-[color:var(--utility-muted-text)]">{subtaskLabel}</div> : null}
          </div>
          {!nested && 'responseMessageId' in task ? (
            <TaskActions
              responseMessageId={task.responseMessageId}
              artifactId={artifactId}
              onOpenArtifact={onOpenArtifact}
              onNavigateToResponse={onNavigateToResponse}
            />
          ) : null}
        </div>
        {task.target ? <div className="mt-2 break-all font-mono text-[10.5px] text-[color:var(--utility-muted-text)]">{task.target}</div> : null}
        {task.writeScope.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {task.writeScope.map((scope) => (
              <span key={`${task.id}:${scope}`} className="rounded-full border border-[color:var(--app-divider)] px-2 py-0.5 font-mono text-[10.5px] text-[color:var(--utility-muted-text)]">
                {scope}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function artifactCategory(artifact: SessionArtifact): NonNullable<SessionArtifact['category']> {
  return artifact.category ?? 'artifact';
}

function firstLinkedArtifactId(task: TaskDashboardItem, artifacts: SessionArtifact[]) {
  const generatedArtifactIds = new Set(
    artifacts
      .filter((artifact) => artifactCategory(artifact) === 'artifact')
      .map((artifact) => artifact.id),
  );
  return task.artifactIds.find((artifactId) => generatedArtifactIds.has(artifactId)) ?? task.artifactIds[0] ?? null;
}

function TaskRow({
  task,
  artifacts,
  onOpenArtifact,
  onNavigateToResponse,
}: {
  task: TaskDashboardItem;
  artifacts: SessionArtifact[];
  onOpenArtifact?: (artifactId: string) => void;
  onNavigateToResponse?: (messageId: string) => void;
}) {
  const artifactId = firstLinkedArtifactId(task, artifacts);

  if (task.subtasks.length === 0) {
    return (
      <div className="app-inspector-source-row">
        <TaskContent task={task} artifactId={artifactId} onOpenArtifact={onOpenArtifact} onNavigateToResponse={onNavigateToResponse} />
      </div>
    );
  }

  return (
    <details className="group app-inspector-source-row">
      <summary className="list-none cursor-pointer [&::-webkit-details-marker]:hidden">
        <TaskContent task={task} artifactId={artifactId} onOpenArtifact={onOpenArtifact} onNavigateToResponse={onNavigateToResponse} />
      </summary>
      <div className="mt-3 space-y-2 border-l border-[color:var(--app-divider)] pl-4">
        {task.subtasks.map((subtask) => (
          <div key={subtask.id} className="rounded-2xl bg-[color:var(--app-transcript-assistant-bg)]/45 px-3 py-2.5">
            <TaskContent task={subtask} nested />
          </div>
        ))}
      </div>
    </details>
  );
}

export function TaskActivityDashboardPanel({ messages, liveTurn, emptyMessage, artifacts = [], onOpenArtifact, onNavigateToResponse }: TaskActivityDashboardPanelProps) {
  const dashboard = useMemo(() => buildTaskActivityDashboard({ messages, liveTurn }), [liveTurn, messages]);

  return (
    <section className="app-detail-section">
      <div className="flex items-center justify-between gap-3">
        <div className="app-detail-kicker">Tasks</div>
        {dashboard.hasActivity ? (
          <div className="text-[11px] text-[color:var(--utility-muted-text)]">
            {dashboard.activeCount > 0 ? `${dashboard.activeCount} active` : `${dashboard.totalCount} total`}
          </div>
        ) : null}
      </div>
      {dashboard.hasActivity ? (
        <div className="app-inspector-list">
          {dashboard.tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              artifacts={artifacts}
              onOpenArtifact={onOpenArtifact}
              onNavigateToResponse={onNavigateToResponse}
            />
          ))}
        </div>
      ) : (
        <div className="app-inspector-empty">{emptyMessage}</div>
      )}
    </section>
  );
}
