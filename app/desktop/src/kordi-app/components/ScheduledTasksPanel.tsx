import type { ScheduledTask } from '@/features/cloud/scheduledTasksClient';

type ScheduledTasksPanelProps = {
  tasks: ScheduledTask[];
  onPause: (taskId: string) => void;
  onResume: (taskId: string) => void;
  onRunNow: (taskId: string) => void;
  onDelete: (taskId: string) => void;
  now?: Date;
  timeZone?: string;
};

function dateParts(date: Date, timeZone?: string): { day: string; time: string } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

function friendlyInstantLabel(value: string, now: Date, timeZone?: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const scheduled = dateParts(date, timeZone);
  const current = dateParts(now, timeZone);
  if (scheduled.day === current.day) return `Today ${scheduled.time}`;
  return `${scheduled.day} ${scheduled.time}`;
}

function scheduleLabel(task: ScheduledTask, now: Date, timeZone?: string): string {
  if (task.schedule.kind === 'daily') return `Daily at ${task.schedule.time} ${task.schedule.timezone ?? 'UTC'}`;
  return friendlyInstantLabel(task.schedule.at, now, timeZone);
}

function runtimeLabel(task: ScheduledTask): string {
  return task.targetRuntime === 'local_required' ? 'Requires Desktop' : 'Cloud';
}

function statusLabel(task: ScheduledTask): string {
  if (task.lastRunStatus === 'waiting_for_desktop') return 'Waiting for Desktop';
  if (task.status === 'paused') return 'Paused';
  return task.lastRunStatus ?? 'Active';
}

export function ScheduledTasksPanel({
  tasks,
  onPause,
  onResume,
  onRunNow,
  onDelete,
  now = new Date(),
  timeZone,
}: ScheduledTasksPanelProps) {
  return (
    <section className="app-scheduled-tools-panel grid gap-3">
      <header className="grid gap-1">
        <h2 className="text-[15px] font-semibold text-foreground">Scheduled tools</h2>
        <p className="text-[12px] text-muted-foreground">Cloud-backed tool runs created by agents.</p>
      </header>
      {tasks.length === 0 ? (
        <p className="rounded-2xl border border-[var(--app-divider)] bg-[var(--app-card-bg)] p-4 text-[13px] text-muted-foreground">
          No scheduled tools yet. Ask Kordi to run something every morning.
        </p>
      ) : (
        <div className="grid gap-2">
          {tasks.map((task) => (
            <article key={task.taskId} className="rounded-2xl border border-[var(--app-divider)] bg-[var(--app-card-bg)] p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="grid gap-1">
                  <h3 className="text-[14px] font-semibold text-foreground">{task.title}</h3>
                  <p className="text-[12px] text-muted-foreground">{scheduleLabel(task, now, timeZone)} · {runtimeLabel(task)}</p>
                  <p className="text-[12px] text-muted-foreground">{statusLabel(task)}</p>
                </div>
                <div className="flex flex-wrap justify-end gap-1.5">
                  {task.status === 'paused' ? (
                    <button type="button" onClick={() => onResume(task.taskId)}>Resume</button>
                  ) : (
                    <button type="button" onClick={() => onPause(task.taskId)}>Pause</button>
                  )}
                  <button type="button" onClick={() => onRunNow(task.taskId)}>Run now</button>
                  <button type="button" onClick={() => onDelete(task.taskId)}>Delete</button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
