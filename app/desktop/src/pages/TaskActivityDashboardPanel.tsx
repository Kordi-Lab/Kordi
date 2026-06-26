import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { CheckCircle2, Circle, CornerDownLeft, FileText, XCircle } from 'lucide-react';
import { IdentityAvatar } from '@/kordi-app/components/IdentityAvatar';
import { navigateToTranscriptMessage } from '@/kordi-app/components/transcriptReplyAttribution';
import type { ConversationParticipant, DesktopChatTurnSnapshot, Message, SessionArtifact, SessionTaskActivity } from '@/kordi-app/types';
import type { ScheduledTask, ScheduledTaskRun } from '@/features/cloud/scheduledTasksClient';
import { buildTaskActivityDashboard, type TaskDashboardItem, type TaskDashboardSubtask, type TaskDashboardTone } from '@/features/chat/taskActivityDashboard';
import { cn } from '@/lib/utils';

type TaskTargetParticipant = Pick<ConversationParticipant,
  | 'id'
  | 'name'
  | 'kind'
  | 'role'
  | 'ownerName'
  | 'avatarKey'
  | 'profileImageUrl'
> & {
  avatarSeed?: string | null;
};

type TaskDashboardSubtaskWithOutput = TaskDashboardSubtask & {
  responseMessageId?: string | null;
  outputPreview?: boolean;
};

type TaskDashboardItemWithParticipants = Omit<TaskDashboardItem, 'subtasks'> & {
  targetParticipants?: TaskTargetParticipant[];
  subtasks: TaskDashboardSubtaskWithOutput[];
  subtaskCountLabel?: string | null;
};

type TaskActivityDashboardPanelProps = {
  messages: Message[];
  liveTurn?: DesktopChatTurnSnapshot | null;
  emptyMessage: string;
  artifacts?: SessionArtifact[];
  taskActivities?: SessionTaskActivity[];
  scheduledTasks?: ScheduledTask[];
  scheduledRunsByTaskId?: Record<string, ScheduledTaskRun[]>;
  currentSessionId?: string | null;
  targetParticipants?: TaskTargetParticipant[];
  onOpenArtifact?: (artifactId: string) => void;
  onNavigateToResponse?: (messageId: string) => void;
  now?: Date;
  timeZone?: string;
};

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
  const iconClassName = cn(nested ? 'mt-0.5 h-3.5 w-3.5 shrink-0' : 'mt-0.5 h-4 w-4 shrink-0', statusCheckboxClass(task.tone));
  const dataAttribute = nested ? { 'data-subtask-status-icon': 'checkbox' } : { 'data-task-status-icon': 'checkbox' };
  if (task.status === 'completed' || task.status === 'closed') {
    return <CheckCircle2 {...dataAttribute} className={iconClassName} aria-hidden="true" />;
  }
  if (task.status === 'failed') {
    return <XCircle {...dataAttribute} className={iconClassName} aria-hidden="true" />;
  }
  return <Circle {...dataAttribute} className={iconClassName} aria-hidden="true" />;
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

function normalizedParticipantMatchText(value?: string | null) {
  return (value ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function userNumberLabel(value: string) {
  return /\buser\s*(\d+)\b/i.exec(value)?.[1] ?? null;
}

function taskSearchText(task: TaskDashboardItem) {
  return [
    task.title,
    task.summary,
    task.target,
    ...task.subtasks.flatMap((subtask) => [subtask.title, subtask.summary, subtask.target]),
  ].filter((value): value is string => Boolean(value?.trim())).join(' ');
}

function participantAliasValues(participant: Pick<TaskTargetParticipant, 'id' | 'name' | 'ownerName' | 'avatarKey'>) {
  const values = [participant.name, participant.ownerName, participant.id, participant.avatarKey]
    .filter((value): value is string => Boolean(value?.trim()));
  return Array.from(new Set(values.flatMap((value) => {
    const trimmed = value.trim();
    const withoutPrefix = trimmed.includes(':') ? trimmed.split(':').filter(Boolean).pop() ?? trimmed : trimmed;
    return [trimmed, withoutPrefix];
  }).filter(Boolean)));
}

function participantMatchesTask(participant: TaskTargetParticipant, taskText: string, normalizedTaskText: string) {
  for (const alias of participantAliasValues(participant)) {
    const normalizedAlias = normalizedParticipantMatchText(alias);
    if (normalizedAlias && (normalizedTaskText.includes(normalizedAlias) || normalizedAlias.includes(normalizedTaskText))) return true;
    const participantUserNumber = userNumberLabel(alias);
    if (participantUserNumber && participantUserNumber === userNumberLabel(taskText)) return true;
  }
  return false;
}

function fallbackParticipantForInvolvedName(name: string): TaskTargetParticipant {
  return {
    id: `task-involved:${name}`,
    name,
    kind: 'human',
    role: 'participant',
    avatarKey: name,
  };
}

function taskTargetParticipants(task: TaskDashboardItem, participants: TaskTargetParticipant[]) {
  if (task.involvedParticipantNames.length === 0) return [];
  const involvedText = task.involvedParticipantNames.join(' ');
  const normalizedInvolvedText = normalizedParticipantMatchText(involvedText);
  const humans = participants.filter((participant) => participant.kind !== 'agent' && participantMatchesTask(participant, involvedText, normalizedInvolvedText));
  const matched = (humans.length > 0 ? humans : participants.filter((participant) => participantMatchesTask(participant, involvedText, normalizedInvolvedText))).slice(0, 4);
  const matchedText = normalizedParticipantMatchText(matched.flatMap(participantAliasValues).join(' '));
  const fallbackParticipants = task.involvedParticipantNames
    .filter((name) => {
      const normalizedName = normalizedParticipantMatchText(name);
      return normalizedName && !matchedText.includes(normalizedName);
    })
    .map(fallbackParticipantForInvolvedName);
  return [...matched, ...fallbackParticipants].slice(0, 4);
}

function TaskTargetAvatars({ participants }: { participants: TaskTargetParticipant[] }) {
  if (participants.length === 0) return null;
  return (
    <div className="flex shrink-0 -space-x-2" aria-label="Task target participants">
      {participants.map((participant) => (
        <IdentityAvatar
          key={participant.id}
          kind={participant.kind === 'agent' ? 'agent' : 'human'}
          seed={participant.avatarKey ?? participant.avatarSeed ?? participant.name}
          avatarKey={participant.avatarKey}
          imageUrl={participant.profileImageUrl}
          name={participant.name}
          className="h-7 w-7 border-2 border-[color:var(--app-panel-bg)]"
          generatedClassName="scale-105"
        />
      ))}
    </div>
  );
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
  targetParticipants = [],
  onOpenArtifact,
  onNavigateToResponse,
}: {
  task: TaskDashboardItem | TaskDashboardSubtask;
  nested?: boolean;
  artifactId?: string | null;
  targetParticipants?: TaskTargetParticipant[];
  onOpenArtifact?: (artifactId: string) => void;
  onNavigateToResponse?: (messageId: string) => void;
}) {
  const rawSecondaryText = task.summary || task.target || (nested ? 'No run details yet.' : 'Task is running.');
  const genericCompletedSummary = /^(?:complete|completed|response complete|done)$/i.test(rawSecondaryText.trim());
  const secondaryText = (task.status === 'completed' || task.status === 'waiting') && genericCompletedSummary ? '' : rawSecondaryText;
  const runningElapsed = useRunningElapsedLabel(task.status === 'active', task.id, task.startedAtMs);
  const subtaskCount = 'subtaskCount' in task ? task.subtaskCount : 0;
  const activeSubtaskCount = 'activeSubtaskCount' in task ? task.activeSubtaskCount : 0;
  const customSubtaskLabel = 'subtaskCountLabel' in task && typeof task.subtaskCountLabel === 'string' ? task.subtaskCountLabel : null;
  const rawSubtaskLabel = customSubtaskLabel ?? (subtaskCount > 0
    ? activeSubtaskCount > 0
      ? `${activeSubtaskCount} active subtask${activeSubtaskCount === 1 ? '' : 's'}`
      : `${subtaskCount} subtask${subtaskCount === 1 ? '' : 's'}`
    : null);
  const subtaskLabel = rawSubtaskLabel && rawSubtaskLabel !== secondaryText ? rawSubtaskLabel : null;
  const durationText = task.status === 'completed' || task.status === 'closed' || task.status === 'waiting'
    ? null
    : task.durationLabel ?? (runningElapsed ? `Running · ${runningElapsed}` : null);
  const timeParts = [task.timeLabel, durationText].filter((part): part is string => Boolean(part));
  const subtaskStatusParts = nested
    ? [task.statusLabel, ...timeParts].filter((part): part is string => Boolean(part?.trim()))
    : [];

  return (
    <div className={cn('flex min-w-0 items-start gap-3', nested && 'gap-2.5')}>
      <TaskStatusIcon task={task} nested={nested} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <div className={cn('app-inspector-heading whitespace-normal break-words leading-5', nested && 'text-[12px] leading-4')}>{task.title}</div>
            {secondaryText ? <div className="mt-1 app-inspector-text-block">{secondaryText}</div> : null}
            {subtaskStatusParts.length > 0 ? (
              <div data-subtask-status-label="true" className="mt-1 text-[11px] text-[color:var(--utility-muted-text)]">{subtaskStatusParts.join(' · ')}</div>
            ) : timeParts.length > 0 ? <div className="mt-1 text-[11px] text-[color:var(--utility-muted-text)]">{timeParts.join(' · ')}</div> : null}
            {subtaskLabel ? <div className="mt-1 text-[11px] text-[color:var(--utility-muted-text)]">{subtaskLabel}</div> : null}
          </div>
          {!nested && 'responseMessageId' in task ? (
            <div className="flex shrink-0 items-center gap-2">
              <TaskTargetAvatars participants={targetParticipants} />
              <TaskActions
                responseMessageId={task.responseMessageId}
                artifactId={artifactId}
                onOpenArtifact={onOpenArtifact}
                onNavigateToResponse={onNavigateToResponse}
              />
            </div>
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

function firstLinkedArtifactId(task: TaskDashboardItemWithParticipants, artifacts: SessionArtifact[]) {
  const generatedArtifactIds = new Set(
    artifacts
      .filter((artifact) => artifactCategory(artifact) === 'artifact')
      .map((artifact) => artifact.id),
  );
  return task.artifactIds.find((artifactId) => generatedArtifactIds.has(artifactId)) ?? task.artifactIds[0] ?? null;
}

function dashboardStatusFromActivity(status: string): TaskDashboardItem['status'] {
  const normalized = status.trim().toLowerCase();
  if (normalized === 'complete' || normalized === 'completed') return 'planned';
  if (normalized === 'closed' || normalized === 'failed') return normalized;
  if (normalized === 'cancelled' || normalized === 'timeout') return 'failed';
  if (normalized === 'processing' || normalized === 'active') return 'active';
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

function matchingCanonicalParticipant(participant: SessionTaskActivity['participants'][number] | SessionTaskActivity['initiator'] | null | undefined, targetParticipants: TaskTargetParticipant[]) {
  if (!participant) return undefined;
  const participantAliases = new Set(participantAliasValues(participant).map(normalizedParticipantMatchText).filter(Boolean));
  return targetParticipants.find((targetParticipant) => (
    participantAliasValues(targetParticipant)
      .map(normalizedParticipantMatchText)
      .filter(Boolean)
      .some((alias) => participantAliases.has(alias))
  ));
}

function enrichTaskParticipant(participant: SessionTaskActivity['participants'][number], targetParticipants: TaskTargetParticipant[]): SessionTaskActivity['participants'][number] {
  const canonical = matchingCanonicalParticipant(participant, targetParticipants);
  return canonical ? {
    ...participant,
    name: canonical.name || participant.name,
    avatarKey: canonical.avatarKey ?? participant.avatarKey,
    profileImageUrl: canonical.profileImageUrl ?? participant.profileImageUrl,
    role: canonical.role ?? participant.role,
  } : participant;
}

function taskActivityToDashboardItem(activity: SessionTaskActivity, targetParticipants: TaskTargetParticipant[]): TaskDashboardItemWithParticipants {
  const status = dashboardStatusFromActivity(activity.status);
  const title = activity.target?.name ?? activity.bridgeRequestId ?? 'Cloud task';
  const initiator = matchingCanonicalParticipant(activity.initiator, targetParticipants) ?? activity.initiator;
  const participants = activity.participants.map((participant) => enrichTaskParticipant(participant, targetParticipants));
  return {
    id: activity.id,
    title,
    summary: activity.error ?? `Synced Cloud task${initiator?.name ? ` by ${initiator.name}` : ''}.`,
    status,
    statusLabel: dashboardStatusLabel(status),
    tone: dashboardToneFromStatus(status),
    target: activity.bridgeRequestId ? `ID: ${activity.bridgeRequestId}` : null,
    writeScope: [],
    live: status === 'active',
    timeLabel: null,
    startedAtMs: activity.createdAtMs || null,
    responseMessageId: activity.bridgeRequestId ?? null,
    taskId: activity.bridgeRequestId ?? activity.id,
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
    id.startsWith('bridge-message:') ? id.split(':').filter(Boolean).pop() ?? null : null,
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

function scheduledTaskToDashboardItem(task: ScheduledTask, now: Date, timeZone: string | undefined, runs: ScheduledTaskRun[], messages: Message[]): TaskDashboardItemWithParticipants {
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

function TaskRow({
  task,
  artifacts,
  targetParticipants,
  onOpenArtifact,
  onNavigateToResponse,
}: {
  task: TaskDashboardItemWithParticipants;
  artifacts: SessionArtifact[];
  targetParticipants: TaskTargetParticipant[];
  onOpenArtifact?: (artifactId: string) => void;
  onNavigateToResponse?: (messageId: string) => void;
}) {
  const artifactId = firstLinkedArtifactId(task, artifacts);
  const matchedTargetParticipants = task.targetParticipants ?? taskTargetParticipants(task, targetParticipants);

  if (task.subtasks.length === 0) {
    return (
      <div className="app-inspector-source-row">
        <TaskContent task={task} artifactId={artifactId} targetParticipants={matchedTargetParticipants} onOpenArtifact={onOpenArtifact} onNavigateToResponse={onNavigateToResponse} />
      </div>
    );
  }

  return (
    <details className="group app-inspector-source-row">
      <summary className="list-none cursor-pointer [&::-webkit-details-marker]:hidden">
        <TaskContent task={task} artifactId={artifactId} targetParticipants={matchedTargetParticipants} onOpenArtifact={onOpenArtifact} onNavigateToResponse={onNavigateToResponse} />
      </summary>
      <div className="mt-3 space-y-2 border-l border-[color:var(--app-divider)] pl-4">
        {task.subtasks.map((subtask) => {
          const rowClassName = 'rounded-2xl bg-[color:var(--app-transcript-assistant-bg)]/45 px-3 py-2.5';
          const responseMessageId = subtask.responseMessageId;
          if (!responseMessageId) {
            return (
              <div key={subtask.id} className={rowClassName}>
                <TaskContent task={subtask} nested />
              </div>
            );
          }
          return (
            <button
              key={subtask.id}
              type="button"
              data-scheduled-run-output={subtask.outputPreview ? 'true' : undefined}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onNavigateToResponse?.(responseMessageId);
              }}
              className={cn('block w-full text-left transition hover:bg-[color:var(--app-transcript-assistant-bg)]/70', rowClassName)}
            >
              <TaskContent task={subtask} nested />
            </button>
          );
        })}
      </div>
    </details>
  );
}

function taskDedupeKeys(task: Pick<TaskDashboardItem, 'id' | 'taskId' | 'title'>) {
  const normalizedTitle = task.title?.trim().replace(/\s+/g, ' ').toLowerCase();
  return [
    task.taskId ? `task-id:${task.taskId.trim().toLowerCase()}` : null,
    normalizedTitle ? `task-title:${normalizedTitle}` : null,
    task.id ? `id:${task.id.trim().toLowerCase()}` : null,
  ].filter((value): value is string => Boolean(value));
}

function dedupeTaskRowsByKeys<T extends Pick<TaskDashboardItem, 'id' | 'taskId' | 'title'>>(tasks: T[]): T[] {
  const seen = new Set<string>();
  const rows: T[] = [];
  for (const task of tasks) {
    const keys = taskDedupeKeys(task);
    if (keys.some((key) => seen.has(key))) continue;
    rows.push(task);
    keys.forEach((key) => seen.add(key));
  }
  return rows;
}

function dedupeScheduledTaskRows<T extends Pick<TaskDashboardItem, 'taskId'>>(tasks: T[]): T[] {
  const seen = new Set<string>();
  const rows: T[] = [];
  for (const task of tasks) {
    const key = task.taskId?.trim().toLowerCase();
    if (key && seen.has(key)) continue;
    rows.push(task);
    if (key) seen.add(key);
  }
  return rows;
}

function participantDedupeKey(participant: TaskTargetParticipant) {
  const accountAlias = participantAliasValues(participant).find((alias) => /^acct_[a-z0-9]+$/i.test(alias));
  if (accountAlias) return `account:${accountAlias.toLowerCase()}`;
  return `name:${normalizedParticipantMatchText(participant.name) || participant.id}`;
}

function participantNameLooksTechnical(name?: string | null) {
  const value = name?.trim() ?? '';
  return !value || /^acct_[a-z0-9]+$/i.test(value) || /^cloud:acct_[a-z0-9]+$/i.test(value);
}

function mergeTaskTargetParticipants(participants: TaskTargetParticipant[]) {
  const byKey = new Map<string, TaskTargetParticipant>();
  for (const participant of participants) {
    const key = participantDedupeKey(participant);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, participant);
      continue;
    }
    const participantHasBetterName = participantNameLooksTechnical(existing.name) && !participantNameLooksTechnical(participant.name);
    byKey.set(key, {
      ...existing,
      ...participant,
      name: participantHasBetterName ? participant.name : existing.name,
      ownerName: participant.ownerName ?? existing.ownerName,
      avatarKey: participant.avatarKey ?? existing.avatarKey,
      avatarSeed: participant.avatarSeed ?? existing.avatarSeed,
      profileImageUrl: participant.profileImageUrl ?? existing.profileImageUrl,
      role: participant.role ?? existing.role,
    });
  }
  return [...byKey.values()];
}

export function TaskActivityDashboardPanel({ messages, liveTurn, emptyMessage, artifacts = [], taskActivities = [], scheduledTasks = [], scheduledRunsByTaskId = {}, currentSessionId = null, targetParticipants = [], onOpenArtifact, onNavigateToResponse, now = new Date(), timeZone }: TaskActivityDashboardPanelProps) {
  // Conversation message arrays can be updated in place while Bridge/canonical polling is active.
  // Recompute on every render so a newly attached task_operator/update_plan tool appears as soon
  // as the transcript rerenders, even if the array identity did not change.
  const dashboard = buildTaskActivityDashboard({ messages, liveTurn });
  const activityTargetParticipants: TaskTargetParticipant[] = taskActivities.flatMap((activity) => activity.participants.map((participant) => ({
    id: participant.id,
    name: participant.name,
    kind: participant.kind === 'agent' ? 'agent' : 'human',
    role: participant.role,
    avatarKey: participant.avatarKey,
    profileImageUrl: participant.profileImageUrl,
  })));
  const mergedTargetParticipants = mergeTaskTargetParticipants([...activityTargetParticipants, ...targetParticipants]);
  const normalizedCurrentSessionId = currentSessionId?.trim() ?? '';
  const sessionScheduledTasks = normalizedCurrentSessionId
    ? scheduledTasks.filter((task) => task.sessionId?.trim() === normalizedCurrentSessionId)
    : scheduledTasks;
  const scheduledRows = dedupeScheduledTaskRows(sessionScheduledTasks.map((task) => scheduledTaskToDashboardItem(task, now, timeZone, scheduledRunsByTaskId[task.taskId] ?? [], messages)));
  const taskActivityRows = dedupeTaskRowsByKeys(taskActivities.map((activity) => taskActivityToDashboardItem(activity, mergedTargetParticipants)));
  const existingTaskKeys = new Set([...scheduledRows, ...taskActivityRows].flatMap(taskDedupeKeys));
  const localRows = dashboard.tasks.filter((task) => !taskDedupeKeys(task).some((key) => existingTaskKeys.has(key)));
  const tasks = [...scheduledRows, ...taskActivityRows, ...localRows];

  return (
    <section className="app-detail-section">
      {tasks.length > 0 ? (
        <div className="app-inspector-list">
          {tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              artifacts={artifacts}
              targetParticipants={targetParticipants}
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
