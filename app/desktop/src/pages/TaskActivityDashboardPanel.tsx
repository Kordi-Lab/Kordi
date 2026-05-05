import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import type { DesktopChatTurnSnapshot, Message } from '@/kordi-app/types';
import { buildTaskActivityDashboard, type TaskDashboardItem, type TaskDashboardSubtask, type TaskDashboardTone } from '@/features/chat/taskActivityDashboard';
import { cn } from '@/lib/utils';

type TaskActivityDashboardPanelProps = {
  messages: Message[];
  liveTurn?: DesktopChatTurnSnapshot | null;
  emptyMessage: string;
};

function statusBadgeClass(tone: TaskDashboardTone) {
  switch (tone) {
    case 'running':
      return 'app-badge-attention';
    case 'success':
      return 'border-emerald-400/20 bg-emerald-500/10 text-emerald-100';
    case 'closed':
      return 'border-slate-500/20 bg-slate-500/10 text-slate-300';
    case 'error':
      return 'border-rose-400/20 bg-rose-500/10 text-rose-100';
    case 'muted':
    default:
      return 'app-badge-neutral';
  }
}

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
  const subtaskCount = 'subtaskCount' in task ? task.subtaskCount : 0;
  const activeSubtaskCount = 'activeSubtaskCount' in task ? task.activeSubtaskCount : 0;
  const subtaskLabel = subtaskCount > 0
    ? activeSubtaskCount > 0
      ? `${activeSubtaskCount} active subtask${activeSubtaskCount === 1 ? '' : 's'}`
      : `${subtaskCount} subtask${subtaskCount === 1 ? '' : 's'}`
    : null;

  return (
    <div className={cn('flex min-w-0 items-start gap-3', nested && 'gap-2.5')}>
      {expandable ? (
        <span className="mt-0.5 text-[11px] text-[color:var(--utility-muted-text)] transition-transform group-open:rotate-90" aria-hidden="true">▸</span>
      ) : null}
      <span className={cn('mt-1.5 shrink-0 rounded-full', nested ? 'h-1.5 w-1.5' : 'h-2 w-2', statusDotClass(task.tone))} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <div className={cn('app-inspector-heading truncate', nested && 'text-[12px]')}>{task.title}</div>
            <div className="mt-1 app-inspector-text-block">{secondaryText}</div>
            {subtaskLabel ? <div className="mt-1 text-[11px] text-[color:var(--utility-muted-text)]">{subtaskLabel}</div> : null}
          </div>
          <Badge variant="secondary" className={cn('shrink-0 rounded-full px-2.5 py-1', statusBadgeClass(task.tone))}>
            {task.statusLabel}
          </Badge>
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
