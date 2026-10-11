import type { TaskDashboardItem,TaskDashboardTone } from '@/features/chat/taskActivityDashboard';
import type { ScheduledTask,ScheduledTaskRun } from '@/features/cloud/scheduledTasksClient';
import { collaborationMessageSourceId } from '@/features/collaboration/legacyBridgeCompatibility';
import type { Message,SessionTaskActivity } from '@/kordi-app/types';
import { enrichTaskParticipant,matchingCanonicalParticipant,type TaskDashboardItemWithParticipants,type TaskDashboardSubtaskWithOutput,type TaskTargetParticipant } from './taskActivityParticipants';

export function formatTaskElapsed(elapsedMs: number) {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

function dashboardStatusFromActivity(status: string): TaskDashboardItem['status'] {
  const normalized = status.trim().toLowerCase();
  if (normalized === 'complete' || normalized === 'completed' || normalized === 'done') return 'completed';
  if (normalized === 'closed' || normalized === 'failed') return normalized;
  if (normalized === 'cancelled' || normalized === 'timeout') return 'failed';
  if (normalized === 'processing' || normalized === 'active' || normalized === 'running') return 'active';
  return 'planned';
}

function dashboardToneFromStatus(status: TaskDashboardItem['status']): TaskDashboardTone {
  if (status === 'active') return 'running';
  if (status === 'completed') return 'success';
  if (status === 'closed') return 'closed';
  if (status === 'failed') return 'error';
  return 'muted';
}

function dashboardStatusLabel(status: TaskDashboardItem['status']) {
  switch (status) {
    case 'active': return 'Active';
    case 'completed': return 'Done';
    case 'closed': return 'Closed';
    case 'failed': return 'Failed';
    case 'waiting': return 'Needs input';
    case 'planned':
    default: return 'Planned';
  }
}

export function taskActivityToDashboardItem(activity: SessionTaskActivity, targetParticipants: TaskTargetParticipant[]): TaskDashboardItemWithParticipants {
  const status = dashboardStatusFromActivity(activity.status);
  const title = activity.target?.name ?? activity.sourceRequestId ?? 'Cloud task';
  const initiator = matchingCanonicalParticipant(activity.initiator, targetParticipants) ?? activity.initiator;
  const participants = activity.participants.map((participant) => enrichTaskParticipant(participant, targetParticipants));
  return {
    id: activity.id,
    title,
    summary: activity.error ?? (status === 'active' ? 'Last reported as running. No current execution timing is available.' : `Synced Cloud task${initiator?.name ? ` by ${initiator.name}` : ''}.`),
    status,
    statusLabel: dashboardStatusLabel(status),
    tone: dashboardToneFromStatus(status),
    target: activity.sourceRequestId ? `ID: ${activity.sourceRequestId}` : null,
    writeScope: [],
    live: false,
    timeLabel: null,
    startedAtMs: activity.createdAtMs || null,
    responseMessageId: activity.sourceRequestId ?? null,
    taskId: activity.sourceRequestId ?? activity.id,
    artifactIds: [],
    involvedParticipantNames: Array.from(new Set(participants.map((participant) => participant.name).filter(Boolean))),
    targetParticipants: participants.map((participant) => ({
      id: participant.id,
      name: participant.name,
      kind: participant.kind === 'agent' ? 'agent' : 'human',
      role: participant.role,
      avatarKey: participant.avatarKey,
      profileImageUrl: participant.profileImageUrl,
    })),
    subtasks: [],
    subtaskCount: 0,
    activeSubtaskCount: 0,
  };
}

function scheduledDateParts(date: Date, timeZone?: string): { day: string; time: string } {
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

function friendlyScheduledInstantLabel(value: string, now: Date, timeZone?: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const scheduled = scheduledDateParts(date, timeZone);
  const current = scheduledDateParts(now, timeZone);
  if (scheduled.day === current.day) return `Today ${scheduled.time}`;
  return `${scheduled.day} ${scheduled.time}`;
}

function scheduledTaskScheduleLabel(task: ScheduledTask, now: Date, timeZone?: string): string {
  if (task.schedule.kind === 'daily') return `Daily at ${task.schedule.time} ${task.schedule.timezone ?? 'UTC'}`;
  return friendlyScheduledInstantLabel(task.schedule.at, now, timeZone);
}

function scheduledTaskRuntimeLabel(task: ScheduledTask): string | null {
  return task.targetRuntime === 'local_required' ? 'Requires Desktop' : null;
}

function scheduledTaskStatusLabel(task: ScheduledTask): string {
  if (task.lastRunStatus === 'waiting_for_desktop') return 'Waiting for Desktop';
  if (task.status === 'paused') return 'Paused';
  if (task.lastRunStatus === 'completed') return 'Last run completed';
  if (task.lastRunStatus === 'failed') return task.lastRunError ? `Last run failed: ${task.lastRunError}` : 'Last run failed';
  if (task.lastRunStatus === 'queued') return 'Queued';
  if (task.lastRunStatus === 'leased' || task.lastRunStatus === 'running') return 'Running in Cloud';
  if (task.lastRunStatus) return task.lastRunStatus.replace(/_/g, ' ');
  return 'Scheduled';
}

function scheduledTaskDashboardStatus(task: ScheduledTask): TaskDashboardItem['status'] {
  if (task.status === 'paused') return 'waiting';
  if (task.lastRunStatus === 'completed') return 'completed';
  if (task.lastRunStatus === 'failed') return 'failed';
  if (task.lastRunStatus === 'queued' || task.lastRunStatus === 'leased' || task.lastRunStatus === 'running') return 'active';
  return 'planned';
}

function runDurationLabel(run: ScheduledTaskRun): string | null {
  const startMs = Date.parse(run.createdAt);
  const endMs = Date.parse(run.completedAt ?? run.updatedAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  return formatTaskElapsed(endMs - startMs);
}

function scheduledRunStatusLabel(run: ScheduledTaskRun): string {
  const duration = runDurationLabel(run);
  const status = run.status.replace(/_/g, ' ');
  return duration ? `${status} · ${duration}` : status;
}

function messageCloudIds(message: Message): string[] {
  const id = message.id?.trim() ?? '';
  return [
    id,
    id.startsWith('msg:cloud:self:') ? id.slice('msg:cloud:self:'.length) : null,
    collaborationMessageSourceId(id),
  ].filter((value): value is string => Boolean(value?.trim()));
}

function scheduledRunMessage(messages: Message[], resultMessage: string | null): Message | null {
  const target = resultMessage?.trim();
  if (!target) return null;
  return messages.find((message) => messageCloudIds(message).includes(target)) ?? null;
}

function scheduledRunPreview(message: Message | null, run: ScheduledTaskRun): string {
  if (message) {
    const text = message.turn?.assistantText?.trim() || message.text?.trim();
    if (text) return text.length > 150 ? `${text.slice(0, 147).trimEnd()}…` : text;
  }
  if (run.errorMessage?.trim()) return run.errorMessage.trim();
  if (run.errorCode?.trim()) return run.errorCode.trim().replace(/_/g, ' ');
  return run.status === 'completed' ? 'Response posted to this session.' : 'Run is still in progress.';
}

function scheduledRunSubtask(run: ScheduledTaskRun, messages: Message[], now: Date, timeZone?: string): TaskDashboardSubtaskWithOutput {
  const message = scheduledRunMessage(messages, run.resultMessage);
  const status: TaskDashboardItem['status'] = run.status === 'completed'
    ? 'completed'
    : run.status === 'failed'
      ? 'failed'
      : run.status === 'waiting_for_desktop'
        ? 'waiting'
        : 'active';
  return {
    id: `scheduled-run:${run.runId}`,
    title: friendlyScheduledInstantLabel(run.dueAt, now, timeZone),
    summary: scheduledRunPreview(message, run),
    status,
    statusLabel: scheduledRunStatusLabel(run),
    tone: dashboardToneFromStatus(status),
    target: null,
    writeScope: [],
    live: status === 'active',
    timeLabel: null,
    startedAtMs: Date.parse(run.createdAt) || null,
    responseMessageId: message?.id ?? null,
    outputPreview: Boolean(message?.id),
  };
}

export function scheduledTaskToDashboardItem(task: ScheduledTask, now: Date, timeZone: string | undefined, runs: ScheduledTaskRun[], messages: Message[]): TaskDashboardItemWithParticipants {
  const status = scheduledTaskDashboardStatus(task);
  const runSubtasks = runs.slice(0, 5).map((run) => scheduledRunSubtask(run, messages, now, timeZone));
  const latestRun = runs[0] ?? null;
  return {
    id: `scheduled:${task.taskId}`,
    title: task.title,
    summary: scheduledTaskStatusLabel(task),
    status,
    statusLabel: scheduledTaskStatusLabel(task),
    tone: dashboardToneFromStatus(status),
    target: null,
    writeScope: [],
    live: status === 'active',
    timeLabel: [scheduledTaskScheduleLabel(task, now, timeZone), scheduledTaskRuntimeLabel(task)]
      .filter((part): part is string => Boolean(part))
      .join(' · '),
    startedAtMs: latestRun ? Date.parse(latestRun.createdAt) || null : null,
    responseMessageId: null,
    taskId: task.taskId,
    artifactIds: [],
    involvedParticipantNames: [],
    targetParticipants: [],
    subtasks: runSubtasks,
    subtaskCount: runSubtasks.length,
    activeSubtaskCount: runSubtasks.filter((run) => run.status === 'active').length,
    subtaskCountLabel: runSubtasks.length > 0 ? `${runSubtasks.length} run${runSubtasks.length === 1 ? '' : 's'}` : null,
  };
}
