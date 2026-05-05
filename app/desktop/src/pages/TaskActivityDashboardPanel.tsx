import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import type { DesktopChatTurnSnapshot, Message } from '@/kordi-app/types';
import { buildTaskActivityDashboard, type TaskDashboardItem, type TaskDashboardTone } from '@/features/chat/taskActivityDashboard';
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

function TaskRow({ task }: { task: TaskDashboardItem }) {
  const secondaryText = task.summary || task.target || 'No task details yet.';
  return (
    <div className="app-inspector-source-row">
      <div className="flex min-w-0 items-start gap-3">
        <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', statusDotClass(task.tone))} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="app-inspector-heading truncate">{task.title}</div>
              <div className="mt-1 app-inspector-text-block">{secondaryText}</div>
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
    </div>
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
