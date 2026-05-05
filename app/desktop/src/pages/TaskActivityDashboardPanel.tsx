import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import type { DesktopChatTurnSnapshot, Message } from '@/kordi-app/types';
import { buildTaskActivityDashboard, type TaskActivityItem, type TaskActivitySubagent, type TaskActivityTone } from '@/features/chat/taskActivityDashboard';
import { cn } from '@/lib/utils';

type TaskActivityDashboardPanelProps = {
  messages: Message[];
  liveTurn?: DesktopChatTurnSnapshot | null;
  emptyMessage: string;
};

function statusBadgeClass(tone: TaskActivityTone) {
  switch (tone) {
    case 'running':
      return 'app-badge-attention';
    case 'success':
      return 'border-emerald-400/20 bg-emerald-500/10 text-emerald-100';
    case 'closed':
      return 'border-slate-500/20 bg-slate-500/10 text-slate-300';
    case 'error':
      return 'border-rose-400/20 bg-rose-500/10 text-rose-100';
    case 'ready':
    case 'muted':
    default:
      return 'app-badge-neutral';
  }
}

function MetricTile({ label, value, hint }: { label: string; value: string | number; hint: string }) {
  return (
    <div className="rounded-[16px] border border-[color:var(--app-divider)] bg-[color:var(--app-control-bg)] px-3 py-2.5">
      <div className="text-[18px] font-semibold leading-none text-[color:var(--utility-foreground)]">{value}</div>
      <div className="mt-1 text-[11px] font-medium text-[color:var(--utility-muted-text)]">{label}</div>
      <div className="mt-1 text-[10.5px] leading-4 text-[color:var(--utility-muted-text)]">{hint}</div>
    </div>
  );
}

function SubagentRow({ subagent }: { subagent: TaskActivitySubagent }) {
  return (
    <div className="app-inspector-source-row">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="app-inspector-heading truncate">{subagent.name}</div>
          <div className="mt-1 break-all app-inspector-subtext">{subagent.target}</div>
        </div>
        <Badge variant="secondary" className={cn('shrink-0 rounded-full px-2.5 py-1', subagent.status === 'active' ? 'app-badge-attention' : statusBadgeClass(subagent.status === 'failed' ? 'error' : subagent.status === 'completed' ? 'success' : 'closed'))}>
          {subagent.statusLabel}
        </Badge>
      </div>
      {subagent.writeScope.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {subagent.writeScope.map((scope) => (
            <span key={`${subagent.target}:${scope}`} className="rounded-full border border-[color:var(--app-divider)] px-2 py-0.5 font-mono text-[10.5px] text-[color:var(--utility-muted-text)]">
              {scope}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ActivityRow({ item }: { item: TaskActivityItem }) {
  return (
    <div className="app-inspector-source-row">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            {item.live ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--app-tool-running-fg)]" aria-label="Live" /> : null}
            <div className="app-inspector-heading truncate">{item.title}</div>
          </div>
          <div className="mt-1 text-[11px] font-medium text-[color:var(--utility-muted-text)]">{item.toolName}</div>
        </div>
        <Badge variant="secondary" className={cn('shrink-0 rounded-full px-2.5 py-1', statusBadgeClass(item.tone))}>
          {item.statusLabel}
        </Badge>
      </div>
      {item.detail ? <div className="mt-2 app-inspector-text-block">{item.detail}</div> : null}
      {item.writeScope.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {item.writeScope.map((scope) => (
            <span key={`${item.id}:${scope}`} className="rounded-full border border-[color:var(--app-divider)] px-2 py-0.5 font-mono text-[10.5px] text-[color:var(--utility-muted-text)]">
              {scope}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ActivityGroup({ title, items, empty }: { title: string; items: TaskActivityItem[]; empty: string }) {
  return (
    <section className="app-detail-section">
      <div className="app-detail-kicker">{title}</div>
      {items.length > 0 ? (
        <div className="app-inspector-list">
          {items.map((item) => <ActivityRow key={item.id} item={item} />)}
        </div>
      ) : (
        <div className="app-inspector-empty">{empty}</div>
      )}
    </section>
  );
}

export function TaskActivityDashboardPanel({ messages, liveTurn, emptyMessage }: TaskActivityDashboardPanelProps) {
  const dashboard = useMemo(() => buildTaskActivityDashboard({ messages, liveTurn }), [liveTurn, messages]);

  if (!dashboard.hasActivity) {
    return (
      <section className="app-detail-section">
        <div className="app-detail-kicker">Tasks</div>
        <div className="app-inspector-empty">{emptyMessage}</div>
      </section>
    );
  }

  return (
    <>
      <section className="app-detail-section">
        <div className="app-detail-kicker">Task activity</div>
        <div className="grid grid-cols-3 gap-2">
          <MetricTile label="Active subagents" value={dashboard.activeSubagents.length} hint="Backend task agents" />
          <MetricTile label="Running execution" value={dashboard.activeExecutionCount} hint="Commands or file edits" />
          <MetricTile label="Tracked steps" value={dashboard.totalActivityCount} hint="Planning + execution" />
        </div>
        <div className="mt-3 app-inspector-subtext">Read-only status. Use chat instructions or task_operator calls to change backend work.</div>
      </section>

      {dashboard.subagents.length > 0 ? (
        <section className="app-detail-section">
          <div className="app-detail-kicker">Subagents</div>
          <div className="app-inspector-list">
            {dashboard.subagents.map((subagent) => <SubagentRow key={subagent.target} subagent={subagent} />)}
          </div>
        </section>
      ) : null}

      <ActivityGroup
        title="Planning & coordination"
        items={dashboard.planningCoordination}
        empty="No planning or coordination task activity yet."
      />
      <ActivityGroup
        title="Execution"
        items={dashboard.execution}
        empty="No command or file execution activity yet."
      />
    </>
  );
}
