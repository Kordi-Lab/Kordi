import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { CheckCircle2, Circle, CornerDownLeft, FileText, XCircle } from 'lucide-react';
import { IdentityAvatar } from '@/kordi-app/components/IdentityAvatar';
import { navigateToTranscriptMessage } from '@/kordi-app/components/transcriptReplyAttribution';
import type { ConversationParticipant, DesktopChatTurnSnapshot, Message, SessionArtifact, SessionTaskActivity } from '@/kordi-app/types';
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

type TaskActivityDashboardPanelProps = {
  messages: Message[];
  liveTurn?: DesktopChatTurnSnapshot | null;
  emptyMessage: string;
  artifacts?: SessionArtifact[];
  taskActivities?: SessionTaskActivity[];
  targetParticipants?: TaskTargetParticipant[];
  onOpenArtifact?: (artifactId: string) => void;
  onNavigateToResponse?: (messageId: string) => void;
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

function participantMatchesTask(participant: TaskTargetParticipant, taskText: string, normalizedTaskText: string) {
  const names = [participant.name, participant.ownerName].filter((value): value is string => Boolean(value?.trim()));
  for (const name of names) {
    const normalizedName = normalizedParticipantMatchText(name);
    if (normalizedName && normalizedTaskText.includes(normalizedName)) return true;
    const participantUserNumber = userNumberLabel(name);
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
  const matchedText = normalizedParticipantMatchText(matched.map((participant) => participant.name).join(' '));
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
  const rawSecondaryText = task.summary || task.target || (nested ? 'No subtask details yet.' : 'Task is running.');
  const genericCompletedSummary = /^(?:complete|completed|response complete|done)$/i.test(rawSecondaryText.trim());
  const secondaryText = (task.status === 'completed' || task.status === 'waiting') && genericCompletedSummary ? '' : rawSecondaryText;
  const runningElapsed = useRunningElapsedLabel(task.status === 'active', task.id, task.startedAtMs);
  const subtaskCount = 'subtaskCount' in task ? task.subtaskCount : 0;
  const activeSubtaskCount = 'activeSubtaskCount' in task ? task.activeSubtaskCount : 0;
  const rawSubtaskLabel = subtaskCount > 0
    ? activeSubtaskCount > 0
      ? `${activeSubtaskCount} active subtask${activeSubtaskCount === 1 ? '' : 's'}`
      : `${subtaskCount} subtask${subtaskCount === 1 ? '' : 's'}`
    : null;
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
  targetParticipants,
  onOpenArtifact,
  onNavigateToResponse,
}: {
  task: TaskDashboardItem;
  artifacts: SessionArtifact[];
  targetParticipants: TaskTargetParticipant[];
  onOpenArtifact?: (artifactId: string) => void;
  onNavigateToResponse?: (messageId: string) => void;
}) {
  const artifactId = firstLinkedArtifactId(task, artifacts);
  const matchedTargetParticipants = taskTargetParticipants(task, targetParticipants);

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
        {task.subtasks.map((subtask) => (
          <div key={subtask.id} className="rounded-2xl bg-[color:var(--app-transcript-assistant-bg)]/45 px-3 py-2.5">
            <TaskContent task={subtask} nested />
          </div>
        ))}
      </div>
    </details>
  );
}

export function TaskActivityDashboardPanel({ messages, liveTurn, emptyMessage, artifacts = [], targetParticipants = [], onOpenArtifact, onNavigateToResponse }: TaskActivityDashboardPanelProps) {
  // Conversation message arrays can be updated in place while Bridge/canonical polling is active.
  // Recompute on every render so a newly attached task_operator/update_plan tool appears as soon
  // as the transcript rerenders, even if the array identity did not change.
  const dashboard = buildTaskActivityDashboard({ messages, liveTurn });
  const tasks = dashboard.tasks;

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
