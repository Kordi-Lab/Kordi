import { relatedAgentSessionsFromTools } from '@/features/chat/relatedAgentSessions';
import { buildTaskActivityDashboard,type TaskDashboardItem,type TaskDashboardSubtask,type TaskDashboardTone } from '@/features/chat/taskActivityDashboard';
import { navigateToTranscriptMessage } from '@/features/chat/transcriptNavigation';
import { useAgentSubsessionTasks } from '@/features/cloud/agentSubsessionTasks';
import type { ScheduledTask,ScheduledTaskRun } from '@/features/cloud/scheduledTasksClient';
import { IdentityAvatar } from '@/kordi-app/components/IdentityAvatar';
import type { DesktopChatTurnSnapshot,Message,SessionArtifact,SessionTaskActivity } from '@/kordi-app/types';
import { cn } from '@/lib/utils';
import { CheckCircle2,Circle,CornerDownLeft,FileText,XCircle } from 'lucide-react';
import { useEffect,useRef,useState,type MouseEvent } from 'react';
import { AgentThreadTaskRow } from './AgentThreadTaskRow';
import { formatTaskElapsed,scheduledTaskToDashboardItem,taskActivityToDashboardItem } from './taskActivityDashboardItems';
import { mergeTaskTargetParticipants,taskTargetParticipants,type TaskDashboardItemWithParticipants,type TaskTargetParticipant } from "./taskActivityParticipants";

type TaskActivityDashboardPanelProps = {
  messages: Message[];
  liveTurn?: DesktopChatTurnSnapshot | null;
  emptyMessage: string;
  artifacts?: SessionArtifact[];
  taskActivities?: SessionTaskActivity[];
  scheduledTasks?: ScheduledTask[];
  scheduledRunsByTaskId?: Record<string, ScheduledTaskRun[]>;
  currentSessionId?: string | null;
  agentThreadParentId?: string | null;
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

    if (startedAtRef.current === null || runningKeyRef.current !== key || startedAtMs != null && startedAtRef.current !== startedAtMs) {
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

function TaskTargetAvatars({ participants }: { participants: TaskTargetParticipant[] }) {
  if (participants.length === 0) return null;
  return (
    <div className="flex shrink-0 -space-x-2" aria-label="Task target participants">
      {participants.map((participant) => (
        <IdentityAvatar
          key={participant.id}
          kind={participant.kind === 'agent' ? 'agent' : 'human'}
          seed={participant.agentId ?? participant.avatarKey ?? participant.avatarSeed ?? participant.name} isSelf={participant.kind !== 'agent' && participant.role === 'self'}
          avatarKey={participant.avatarKey}
          imageUrl={participant.profileImageUrl}
          name={participant.name}
          className="h-7 w-7"
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
          className="app-button-quiet grid h-7 w-7 place-items-center rounded-lg p-0"
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
          className="app-button-quiet grid h-7 w-7 place-items-center rounded-lg p-0 text-emerald-300"
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
  const runningElapsed = useRunningElapsedLabel(task.status === 'active' && task.live, task.id, task.startedAtMs);
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
  const target = task.target?.trim() || '';
  const summaryText = secondaryText.trim().replace(/\.$/, '');
  const targetIsSummary = Boolean(target) && secondaryText.trim() === target;
  const nestedSummary = nested && task.summary && !(target && task.summary.includes(target)) && task.summary.trim() !== task.statusLabel
    ? task.summary.trim()
    : '';
  const showTarget = Boolean(target) && !targetIsSummary;
  const inlineTarget = showTarget && (nested || target.length < 40);
  const metaParts = nested
    ? []
    : [targetIsSummary ? '' : summaryText, ...timeParts, subtaskLabel].filter((part): part is string => Boolean(part && part.trim()));
  const metaClassName = 'text-[11px] text-[color:var(--utility-muted-text)]';
  const targetSpan = inlineTarget ? (
    <span className="min-w-0 break-all font-mono text-[10.5px] text-[color:var(--utility-muted-text)]">{target}</span>
  ) : null;

  return (
    <div className={cn('flex min-w-0 items-start gap-3', nested && 'gap-2.5')}>
      <TaskStatusIcon task={task} nested={nested} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0">
              <div className={cn('app-inspector-heading whitespace-normal break-words leading-5', nested && 'text-[12px] leading-4')}>{task.title}</div>
              {nested ? (
                <>
                  {subtaskStatusParts.length > 0 ? (
                    <>
                      <span aria-hidden="true" className={metaClassName}>·</span>
                      <span data-subtask-status-label="true" className={metaClassName}>{subtaskStatusParts.join(' · ')}</span>
                    </>
                  ) : null}
                  {targetSpan ? (
                    <>
                      <span aria-hidden="true" className={metaClassName}>·</span>
                      {targetSpan}
                    </>
                  ) : null}
                </>
              ) : (
                <>
                  {metaParts.length > 0 ? <span data-task-meta="true" className={metaClassName}>{metaParts.join(' · ')}</span> : null}
                  {targetSpan}
                </>
              )}
            </div>
            {nestedSummary ? <div className={cn('mt-0.5', metaClassName)}>{nestedSummary}</div> : null}
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
        {showTarget && !inlineTarget ? <div className="mt-1 break-all font-mono text-[10.5px] text-[color:var(--utility-muted-text)]">{target}</div> : null}
        {task.writeScope.length > 0 ? (
          <div className="mt-1 flex flex-wrap gap-1.5">
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
      <div className="mt-1.5 space-y-1 border-l border-[color:var(--app-divider)] pl-3">
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

export function TaskActivityDashboardPanel({ messages, liveTurn, emptyMessage, artifacts = [], taskActivities = [], scheduledTasks = [], scheduledRunsByTaskId = {}, currentSessionId = null, agentThreadParentId = null, targetParticipants = [], onOpenArtifact, onNavigateToResponse, now = new Date(), timeZone }: TaskActivityDashboardPanelProps) {
  const threads = useAgentSubsessionTasks(agentThreadParentId);
  const delegatedMessages = new Set(messages.filter(message => relatedAgentSessionsFromTools(message.turn?.tools).length > 0));
  const delegatedTaskIds = new Set(threads.tasks.flatMap(task => [task.sessionId, task.parentRequestId]));
  for (const message of delegatedMessages) {
    for (const tool of message.turn?.tools ?? []) {
      if (!relatedAgentSessionsFromTools([tool]).length) continue;
      try {
        const parsed: unknown = JSON.parse(tool.arguments ?? '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
        const args = parsed as Record<string, unknown>;
        for (const value of [args.task_name, args.taskName, args.task_id, args.taskId]) {
          if (typeof value === 'string') delegatedTaskIds.add(value);
        }
      } catch { /* An incomplete tool result cannot identify another task. */ }
    }
  }
  // Conversation message arrays can be updated in place while collaboration/canonical polling is active.
  // Recompute on every render so a newly attached task_operator/update_plan tool appears as soon
  // as the transcript rerenders, even if the array identity did not change.
  const dashboard = buildTaskActivityDashboard({ messages: messages.filter(message => !delegatedMessages.has(message)), liveTurn: relatedAgentSessionsFromTools(liveTurn?.tools).length ? null : liveTurn });
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
  const taskActivityRows = dedupeTaskRowsByKeys(taskActivities.filter(activity => !delegatedTaskIds.has(activity.sourceRequestId ?? activity.id)).map((activity) => taskActivityToDashboardItem(activity, mergedTargetParticipants)));
  const existingTaskKeys = new Set([...scheduledRows, ...taskActivityRows].flatMap(taskDedupeKeys));
  const localRows = dashboard.tasks.filter((task) => !taskDedupeKeys(task).some((key) => existingTaskKeys.has(key)));
  const tasks = [...scheduledRows, ...taskActivityRows, ...localRows];

  return (
    <section className="app-detail-section">
      {threads.error ? <div role="status" className="app-inspector-empty">{threads.error}</div> : null}
      {threads.loading ? <div role="status" className="app-inspector-empty">Loading Agent threads…</div> : null}
      {threads.tasks.length > 0 ? <div className="app-inspector-list" aria-label="Agent threads">
        <div className="app-detail-kicker mb-2">Agent threads</div>
        {threads.tasks.map(task => <AgentThreadTaskRow key={task.sessionId} task={task} />)}
      </div> : null}
      {tasks.length > 0 ? (
        <div className="app-inspector-list">
          {threads.tasks.length > 0 ? <div className="app-detail-kicker mb-2">Other task activity</div> : null}
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
      ) : threads.tasks.length === 0 && !threads.error && !threads.loading ? (
        <div className="app-inspector-empty">{emptyMessage}</div>
      ) : null}
    </section>
  );
}
