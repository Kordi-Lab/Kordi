import { Circle, XCircle, CheckCircle2 } from 'lucide-react';

import type { SessionArtifact, SessionTaskActivity } from '@/kordi-app/types';
import { formatDesktopClockTime } from '@/lib/time';
import { cn } from '@/lib/utils';

type TaskActivityDashboardPanelProps = {
  taskActivities?: SessionTaskActivity[];
  emptyMessage: string;
  artifacts?: SessionArtifact[];
  messages?: unknown[];
  liveTurn?: unknown | null;
  onOpenArtifact?: (artifactId: string) => void;
  onNavigateToResponse?: (messageId: string) => void;
};

type TaskTone = 'running' | 'success' | 'closed' | 'error' | 'muted';

type TaskRowModel = {
  id: string;
  title: string;
  summary: string;
  status: 'active' | 'completed' | 'closed' | 'failed' | 'planned';
  tone: TaskTone;
  statusLabel: string;
  timeLabel?: string | null;
  detail?: string | null;
};

function statusTone(status: string): Pick<TaskRowModel, 'status' | 'tone' | 'statusLabel'> {
  const normalized = status.trim().toLowerCase();
  if (normalized === 'complete' || normalized === 'completed') return { status: 'completed', tone: 'success', statusLabel: 'Complete' };
  if (normalized === 'failed') return { status: 'failed', tone: 'error', statusLabel: 'Failed' };
  if (normalized === 'timeout') return { status: 'failed', tone: 'error', statusLabel: 'Timed out' };
  if (normalized === 'cancelled') return { status: 'closed', tone: 'closed', statusLabel: 'Stopped' };
  if (normalized === 'processing' || normalized === 'sending') return { status: 'active', tone: 'running', statusLabel: 'Running' };
  return { status: 'planned', tone: 'muted', statusLabel: status || 'Pending' };
}

function taskStatusIconClass(tone: TaskTone) {
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

function TaskStatusIcon({ task }: { task: TaskRowModel }) {
  const iconClassName = cn('mt-0.5 h-4 w-4 shrink-0', taskStatusIconClass(task.tone));
  if (task.status === 'completed' || task.status === 'closed') {
    return <CheckCircle2 data-task-status-icon="checkbox" className={iconClassName} aria-hidden="true" />;
  }
  if (task.status === 'failed') {
    return <XCircle data-task-status-icon="checkbox" className={iconClassName} aria-hidden="true" />;
  }
  return <Circle data-task-status-icon="checkbox" className={iconClassName} aria-hidden="true" />;
}

function participantName(activity: SessionTaskActivity, kind: 'initiator' | 'target') {
  return activity[kind]?.name?.trim() || (kind === 'target' ? 'Task' : 'Participant');
}

function taskSummary(activity: SessionTaskActivity) {
  const initiator = participantName(activity, 'initiator');
  const participantCount = activity.participants.length;
  const sharedText = participantCount > 1 ? `Shared with ${participantCount} participants` : null;
  return [`Delegated by ${initiator}`, sharedText].filter(Boolean).join(' · ');
}

function taskRowFromActivity(activity: SessionTaskActivity): TaskRowModel {
  return {
    id: activity.id,
    title: participantName(activity, 'target'),
    summary: taskSummary(activity),
    ...statusTone(activity.status),
    timeLabel: activity.createdAtMs ? formatDesktopClockTime(activity.createdAtMs) : null,
    detail: activity.error ?? null,
  };
}

function TaskRow({ task }: { task: TaskRowModel }) {
  const metaParts = [task.statusLabel, task.timeLabel].filter(Boolean);
  return (
    <div className="app-inspector-source-row">
      <div className="flex min-w-0 items-start gap-3">
        <TaskStatusIcon task={task} />
        <div className="min-w-0 flex-1">
          <div className="app-inspector-heading whitespace-normal break-words leading-5">{task.title}</div>
          {task.summary ? <div className="mt-1 app-inspector-text-block">{task.summary}</div> : null}
          {metaParts.length > 0 ? <div className="mt-1 text-[11px] text-[color:var(--utility-muted-text)]">{metaParts.join(' · ')}</div> : null}
          {task.detail ? <div className="mt-2 break-all font-mono text-[10.5px] text-[color:var(--utility-muted-text)]">{task.detail}</div> : null}
        </div>
      </div>
    </div>
  );
}

export function TaskActivityDashboardPanel({ taskActivities = [], emptyMessage }: TaskActivityDashboardPanelProps) {
  const tasks = taskActivities.map(taskRowFromActivity);

  return (
    <section className="app-detail-section">
      {tasks.length > 0 ? (
        <div className="app-inspector-list">
          {tasks.map((task) => <TaskRow key={task.id} task={task} />)}
        </div>
      ) : (
        <div className="app-inspector-empty">{emptyMessage}</div>
      )}
    </section>
  );
}
