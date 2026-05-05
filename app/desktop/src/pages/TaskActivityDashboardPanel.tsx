import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Circle, XCircle } from 'lucide-react';
import type { DesktopChatTurnSnapshot, Message } from '@/kordi-app/types';
import { buildTaskActivityDashboard, type TaskDashboardItem, type TaskDashboardSubtask, type TaskDashboardTone } from '@/features/chat/taskActivityDashboard';
import { cn } from '@/lib/utils';

type TaskActivityDashboardPanelProps = {
  messages: Message[];
  liveTurn?: DesktopChatTurnSnapshot | null;
  emptyMessage: string;
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

  return running ? formatTaskElapsed(elapsedMs) : null;
}

function TaskContent({
  task,
  nested = false,
  expandable = false,
}: {
  task: TaskDashboardItem | TaskDashboardSubtask;
  nested?: boolean;
  expandable?: boolean;
}) {
  const secondaryText = task.summary || task.target || (nested ? 'No subtask details yet.' : 'Task is running.');
  const runningElapsed = useRunningElapsedLabel(nested && task.status === 'active', task.id);
  const subtaskCount = 'subtaskCount' in task ? task.subtaskCount : 0;
  const activeSubtaskCount = 'activeSubtaskCount' in task ? task.activeSubtaskCount : 0;
  const rawSubtaskLabel = subtaskCount > 0
    ? activeSubtaskCount > 0
      ? `${activeSubtaskCount} active subtask${activeSubtaskCount === 1 ? '' : 's'}`
      : `${subtaskCount} subtask${subtaskCount === 1 ? '' : 's'}`
    : null;
  const subtaskLabel = rawSubtaskLabel && rawSubtaskLabel !== secondaryText ? rawSubtaskLabel : null;

  return (
    <div className={cn('flex min-w-0 items-start gap-3', nested && 'gap-2.5')}>
      {expandable ? (
        <span className="mt-0.5 text-[11px] text-[color:var(--utility-muted-text)] transition-transform group-open:rotate-90" aria-hidden="true">▸</span>
      ) : null}
      <TaskStatusIcon task={task} nested={nested} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <div className={cn('app-inspector-heading truncate', nested && 'text-[12px]')}>{task.title}</div>
            <div className="mt-1 app-inspector-text-block">{secondaryText}</div>
            {runningElapsed ? <div className="mt-1 text-[11px] text-[color:var(--utility-muted-text)]">Running · {runningElapsed}</div> : null}
            {subtaskLabel ? <div className="mt-1 text-[11px] text-[color:var(--utility-muted-text)]">{subtaskLabel}</div> : null}
          </div>
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

function TaskRow({ task }: { task: TaskDashboardItem }) {
  if (task.subtasks.length === 0) {
    return (
      <div className="app-inspector-source-row">
        <TaskContent task={task} />
      </div>
    );
  }

  return (
    <details className="group app-inspector-source-row">
      <summary className="list-none cursor-pointer [&::-webkit-details-marker]:hidden">
        <TaskContent task={task} expandable />
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

export function TaskActivityDashboardPanel({ messages, liveTurn, emptyMessage }: TaskActivityDashboardPanelProps) {
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
          {dashboard.tasks.map((task) => <TaskRow key={task.id} task={task} />)}
        </div>
      ) : (
        <div className="app-inspector-empty">{emptyMessage}</div>
      )}
    </section>
  );
}
