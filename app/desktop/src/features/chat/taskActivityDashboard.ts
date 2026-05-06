import { generatedArtifactIdsFromTurn } from '@/features/chat/artifacts';
import { formatDesktopClockTime } from '@/lib/time';
import type { DesktopChatToolSnapshot, DesktopChatTurnSnapshot, Message } from '@/kordi-app/types';

export type TaskDashboardStatus = 'planned' | 'active' | 'completed' | 'failed' | 'closed';
export type TaskDashboardTone = 'muted' | 'running' | 'success' | 'error' | 'closed';

type TaskDashboardBase = {
  id: string;
  title: string;
  summary: string;
  status: TaskDashboardStatus;
  statusLabel: string;
  tone: TaskDashboardTone;
  target?: string | null;
  writeScope: string[];
  live: boolean;
  timeLabel?: string | null;
  durationLabel?: string | null;
  startedAtMs?: number | null;
};

export type TaskDashboardSubtask = TaskDashboardBase;

export type TaskDashboardItem = TaskDashboardBase & {
  responseMessageId?: string | null;
  artifactIds: string[];
  subtasks: TaskDashboardSubtask[];
  subtaskCount: number;
  activeSubtaskCount: number;
};

export type TaskActivityDashboard = {
  tasks: TaskDashboardItem[];
  activeCount: number;
  completedCount: number;
  totalCount: number;
  hasActivity: boolean;
};

type DashboardInput = {
  messages: Message[];
  liveTurn?: DesktopChatTurnSnapshot | null;
};

type TurnWithSequence = {
  turn: DesktopChatTurnSnapshot;
  live: boolean;
  sequence: number;
  responseMessageId?: string | null;
  timeLabel?: string | null;
};

type ToolWithTurn = TurnWithSequence & {
  tool: DesktopChatToolSnapshot;
  toolSequence: number;
};

type MutableSubtask = TaskDashboardSubtask & {
  nameKey?: string | null;
  sequence: number;
};

type MutableParentTask = Omit<TaskDashboardItem, 'subtasks' | 'subtaskCount' | 'activeSubtaskCount'> & {
  sequence: number;
  mergeKey?: string | null;
  completed: boolean;
  succeeded: boolean;
  message: string;
  assistantText: string;
  responseMessageId?: string | null;
  artifactIds: string[];
  subtasksByKey: Map<string, MutableSubtask>;
};

function safeParseToolArguments(rawArguments?: string | null) {
  if (!rawArguments?.trim()) return null;
  try {
    const parsed = JSON.parse(rawArguments);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stringArrayValue(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
    : [];
}

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function compact(value: string, maxLength = 180) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function formatTaskDuration(durationMs: number) {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

function taskDurationLabel(turn: DesktopChatTurnSnapshot) {
  const startedAtMs = numberValue(turn.startedAtMs);
  const completedAtMs = numberValue(turn.completedAtMs);
  if (startedAtMs === null || completedAtMs === null || completedAtMs < startedAtMs) return null;
  return formatTaskDuration(completedAtMs - startedAtMs);
}

function taskTimeLabel(turn: DesktopChatTurnSnapshot, messageTimeLabel?: string | null) {
  const explicitTime = messageTimeLabel?.trim();
  const fallbackTime = explicitTime
    || (turn.completedAtMs ? formatDesktopClockTime(turn.completedAtMs) : null)
    || (turn.startedAtMs ? formatDesktopClockTime(turn.startedAtMs) : null);
  if (!fallbackTime) return null;
  if (!turn.completed || turn.succeeded) return fallbackTime;
  if (turn.status === 'cancelled') return `Stopped ${fallbackTime}`;
  return `Failed ${fallbackTime}`;
}

function titleFromPrompt(prompt?: string | null) {
  const rawPrompt = prompt?.trim() ?? '';
  if (!rawPrompt) return null;
  const withoutLeadingMention = rawPrompt.replace(/^\s*(?:@\S+\s+)+/, '').trim();
  return compact(withoutLeadingMention || rawPrompt, 96);
}

function titleFromArtifactId(artifactId: string) {
  const fileName = artifactId.split('/').filter(Boolean).pop()?.trim() ?? '';
  const baseName = fileName.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!baseName) return null;
  return compact(baseName.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase()), 96);
}

function titleFromGeneratedArtifacts(artifactIds: string[]) {
  for (const artifactId of artifactIds) {
    const title = titleFromArtifactId(artifactId);
    if (title) return title;
  }
  return null;
}

function titleFromTurnText(turn: DesktopChatTurnSnapshot) {
  const assistantLine = turn.assistantText.split('\n').map((line) => line.trim()).find(Boolean);
  if (assistantLine) return compact(assistantLine.replace(/^#+\s*/, ''), 96);

  const message = turn.message.trim();
  return message && !/^response complete$/i.test(message) ? compact(message, 96) : null;
}

function normalizedTaskTitleKey(title: string) {
  return title.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

function taskMergeKeyFromTitle(title?: string | null) {
  const normalized = title ? normalizedTaskTitleKey(title) : '';
  return normalized ? `task-title:${normalized}` : null;
}

function titleFromTurn(turn: DesktopChatTurnSnapshot, artifactIds: string[], explicitTitle = titleFromToolArguments(turn.tools)) {
  return explicitTitle
    ?? titleFromPrompt(turn.prompt)
    ?? titleFromPrompt(turn.sourceMessage?.text)
    ?? titleFromGeneratedArtifacts(artifactIds)
    ?? titleFromTurnText(turn)
    ?? 'Task';
}

function titleFromToolArguments(tools: DesktopChatToolSnapshot[]) {
  for (const tool of tools) {
    const args = safeParseToolArguments(tool.arguments);
    const title = stringValue(args?.taskTitle);
    if (title) return compact(title, 96);
  }
  return null;
}

function targetFromTaskResult(text?: string | null) {
  const value = text?.trim() ?? '';
  if (!value) return null;
  const match = /(?:Task agent \w+|Task completed|Task failed|Message sent to|Task agent closed):\s*(\S+)/i.exec(value);
  return match?.[1]?.trim() || null;
}

function targetName(target: string) {
  return target.split('/').filter(Boolean).pop() || target;
}

function normalizedStatus(tool: DesktopChatToolSnapshot) {
  return (tool.isError ? 'error' : tool.status || 'pending').trim().toLowerCase();
}

function toolIsStillRunning(tool: DesktopChatToolSnapshot) {
  const status = normalizedStatus(tool);
  return !tool.isError && !['done', 'complete', 'completed', 'succeeded', 'success', 'error', 'failed'].includes(status);
}

function statusMeta(status: TaskDashboardStatus, kind: 'task' | 'subtask' = 'task'): Pick<TaskDashboardBase, 'statusLabel' | 'tone'> {
  switch (status) {
    case 'active':
      return { statusLabel: kind === 'subtask' ? 'Subagent active' : 'Active', tone: 'running' };
    case 'completed':
      return { statusLabel: 'Done', tone: 'success' };
    case 'failed':
      return { statusLabel: 'Failed', tone: 'error' };
    case 'closed':
      return { statusLabel: 'Closed', tone: 'closed' };
    case 'planned':
    default:
      return { statusLabel: 'Planned', tone: 'muted' };
  }
}

function taskKey(target: string | null | undefined, nameKey: string | null | undefined, fallback: string) {
  if (target?.trim()) return `target:${target.trim()}`;
  if (nameKey?.trim()) return `name:${nameKey.trim()}`;
  return fallback;
}

function matchingSubtaskKey(
  subtasksByKey: Map<string, MutableSubtask>,
  target: string | null | undefined,
  nameKey: string | null | undefined,
) {
  const targetKey = target?.trim() ? `target:${target.trim()}` : null;
  if (targetKey && subtasksByKey.has(targetKey)) return targetKey;

  const name = nameKey?.trim();
  if (!name) return null;
  const nameLookup = `name:${name}`;
  if (subtasksByKey.has(nameLookup)) return nameLookup;

  for (const [key, task] of subtasksByKey) {
    if (task.nameKey === name || task.target?.split('/').filter(Boolean).pop() === name) {
      return key;
    }
  }

  return null;
}

function upsertSubtask(parent: MutableParentTask, next: MutableSubtask) {
  const existingKey = matchingSubtaskKey(parent.subtasksByKey, next.target, next.nameKey);
  const existing = existingKey ? parent.subtasksByKey.get(existingKey) : null;
  const merged: MutableSubtask = existing
    ? {
        ...existing,
        ...next,
        title: next.title || existing.title,
        summary: next.summary || existing.summary,
        writeScope: next.writeScope.length > 0 ? next.writeScope : existing.writeScope,
        live: existing.live || next.live,
        sequence: Math.min(existing.sequence, next.sequence),
      }
    : next;

  if (existingKey) {
    parent.subtasksByKey.delete(existingKey);
  }
  parent.subtasksByKey.set(taskKey(merged.target, merged.nameKey, merged.id), merged);
}

function manifestSubtasks(args: Record<string, unknown>, sequence: number, live: boolean): MutableSubtask[] {
  const tasks = Array.isArray(args.tasks) ? args.tasks : [];
  return tasks.flatMap((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const record = candidate as Record<string, unknown>;
    const taskId = stringValue(record.taskId) ?? `manifest_${sequence}_${index}`;
    const title = stringValue(record.title) ?? taskId;
    const summary = stringValue(record.summary) ?? '';
    const writeScope = stringArrayValue(record.writeScope);
    return [{
      id: `manifest:${sequence}:${taskId}`,
      nameKey: taskId,
      title,
      summary,
      status: 'planned' as const,
      ...statusMeta('planned', 'subtask'),
      target: null,
      writeScope,
      live,
      sequence,
    }];
  });
}

function spawnSubtask(tool: DesktopChatToolSnapshot, args: Record<string, unknown>, sequence: number, live: boolean): MutableSubtask | null {
  const taskName = stringValue(args.taskName);
  const resultText = tool.resultText ?? '';
  const target = stringValue(args.target) ?? targetFromTaskResult(resultText) ?? (taskName ? `/root/${taskName}` : null);
  if (!taskName && !target) return null;

  const failed = tool.isError || /task failed|failed|error/i.test(resultText);
  const status: TaskDashboardStatus = failed ? 'failed' : 'active';
  return {
    id: `spawn:${sequence}:${target ?? taskName}`,
    nameKey: taskName ?? (target ? targetName(target) : null),
    title: taskName ?? (target ? targetName(target) : 'Task'),
    summary: compact(resultText),
    status,
    ...statusMeta(status, 'subtask'),
    target,
    writeScope: stringArrayValue(args.writeScope),
    live,
    sequence,
  };
}

function resultSubtask(tool: DesktopChatToolSnapshot, args: Record<string, unknown>, sequence: number, live: boolean): MutableSubtask | null {
  const action = stringValue(args.action);
  const resultText = tool.resultText ?? '';
  const target = stringValue(args.target) ?? targetFromTaskResult(resultText);
  if (!target) return null;

  let status: TaskDashboardStatus | null = null;
  if (tool.isError || /task failed/i.test(resultText)) status = 'failed';
  if (/task completed/i.test(resultText)) status = 'completed';
  if (action === 'close' || /task agent closed/i.test(resultText)) status = 'closed';
  if (!status && toolIsStillRunning(tool)) status = 'active';
  if (!status) return null;

  return {
    id: `result:${sequence}:${target}`,
    nameKey: targetName(target),
    title: targetName(target),
    summary: compact(resultText),
    status,
    ...statusMeta(status, 'subtask'),
    target,
    writeScope: stringArrayValue(args.writeScope),
    live,
    sequence,
  };
}

function subtaskItems({ tool, live, toolSequence }: ToolWithTurn): MutableSubtask[] {
  if (tool.name.trim().toLowerCase() !== 'task_operator') return [];
  const args = safeParseToolArguments(tool.arguments);
  if (!args) return [];

  const action = stringValue(args.action);
  if (action === 'manifest') return manifestSubtasks(args, toolSequence, live);
  if (action === 'spawn') {
    const task = spawnSubtask(tool, args, toolSequence, live);
    return task ? [task] : [];
  }

  const task = resultSubtask(tool, args, toolSequence, live);
  return task ? [task] : [];
}

function collectTurns(messages: Message[], liveTurn?: DesktopChatTurnSnapshot | null) {
  const turns: TurnWithSequence[] = [];
  let sequence = 0;
  for (const message of messages) {
    if (message.turn) {
      turns.push({ turn: message.turn, live: false, sequence: sequence++, responseMessageId: message.id ?? message.turn.id, timeLabel: message.time });
    }
  }

  if (liveTurn && !liveTurn.completed) {
    turns.push({ turn: liveTurn, live: true, sequence: sequence++, responseMessageId: liveTurn.id });
  }

  return turns;
}

function createParentTask({ turn, live, sequence, responseMessageId, timeLabel }: TurnWithSequence): MutableParentTask {
  const status: TaskDashboardStatus = live && !turn.completed ? 'active' : turn.completed && turn.succeeded ? 'completed' : 'failed';
  const artifactIds = generatedArtifactIdsFromTurn(turn);
  const explicitTitle = titleFromToolArguments(turn.tools);
  return {
    id: `turn:${turn.id}`,
    title: titleFromTurn(turn, artifactIds, explicitTitle),
    mergeKey: taskMergeKeyFromTitle(explicitTitle),
    summary: compact(turn.message || turn.assistantText || ''),
    status,
    ...statusMeta(status),
    target: null,
    writeScope: [],
    live,
    timeLabel: taskTimeLabel(turn, timeLabel),
    durationLabel: taskDurationLabel(turn),
    startedAtMs: numberValue(turn.startedAtMs),
    sequence,
    completed: turn.completed,
    succeeded: turn.succeeded,
    message: turn.message,
    assistantText: turn.assistantText,
    responseMessageId,
    artifactIds,
    subtasksByKey: new Map(),
  };
}

function mergeParentTask(existing: MutableParentTask, incoming: MutableParentTask) {
  const incomingIsLater = incoming.sequence >= existing.sequence;
  const bothCompleted = existing.completed && incoming.completed;

  existing.sequence = Math.min(existing.sequence, incoming.sequence);
  existing.completed = bothCompleted;
  existing.succeeded = bothCompleted
    ? (incomingIsLater ? incoming.succeeded : existing.succeeded)
    : existing.succeeded || incoming.succeeded;
  existing.live = existing.live || incoming.live || !existing.completed;
  existing.artifactIds = Array.from(new Set([...existing.artifactIds, ...incoming.artifactIds]));
  existing.writeScope = Array.from(new Set([...existing.writeScope, ...incoming.writeScope]));
  if (!existing.responseMessageId) {
    existing.responseMessageId = incoming.responseMessageId;
  }

  if (incomingIsLater || incoming.live) {
    existing.responseMessageId = incoming.responseMessageId ?? existing.responseMessageId;
    existing.summary = incoming.summary || existing.summary;
    existing.message = incoming.message || existing.message;
    existing.assistantText = incoming.assistantText || existing.assistantText;
    existing.timeLabel = incoming.timeLabel ?? existing.timeLabel;
    existing.durationLabel = incoming.durationLabel ?? existing.durationLabel;
    existing.startedAtMs = incoming.startedAtMs ?? existing.startedAtMs;
  }
}

function findExistingSubtaskParent(parents: MutableParentTask[], subtask: MutableSubtask) {
  for (const parent of parents) {
    if (matchingSubtaskKey(parent.subtasksByKey, subtask.target, subtask.nameKey)) return parent;
  }
  return null;
}

function deriveParentStatus(parent: MutableParentTask, subtasks: TaskDashboardSubtask[]): TaskDashboardStatus {
  if (parent.live && !parent.completed) return 'active';
  if (subtasks.some((subtask) => subtask.status === 'failed')) return 'failed';
  if (subtasks.some((subtask) => subtask.status === 'active')) return 'active';
  if (subtasks.some((subtask) => subtask.status === 'planned')) return 'planned';
  if (subtasks.length > 0 && subtasks.every((subtask) => subtask.status === 'closed')) return 'closed';
  if (subtasks.length > 0 && subtasks.every((subtask) => subtask.status === 'completed' || subtask.status === 'closed')) return 'completed';
  if (parent.completed) return parent.succeeded ? 'completed' : 'failed';
  return 'active';
}

function parentSummary(parent: MutableParentTask, subtasks: TaskDashboardSubtask[]) {
  if (subtasks.length === 0) return compact(parent.message || parent.assistantText || 'Task is running.');
  const active = subtasks.filter((subtask) => subtask.status === 'active').length;
  const planned = subtasks.filter((subtask) => subtask.status === 'planned').length;
  const failed = subtasks.filter((subtask) => subtask.status === 'failed').length;
  const completed = subtasks.filter((subtask) => subtask.status === 'completed' || subtask.status === 'closed').length;
  if (active > 0) return `${active} active subtask${active === 1 ? '' : 's'}${subtasks.length > active ? ` of ${subtasks.length}` : ''}`;
  if (failed > 0) return `${failed} failed subtask${failed === 1 ? '' : 's'}${subtasks.length > failed ? ` of ${subtasks.length}` : ''}`;
  if (planned > 0) return `${planned} planned subtask${planned === 1 ? '' : 's'}${subtasks.length > planned ? ` of ${subtasks.length}` : ''}`;
  if (completed > 0) return `${completed} completed subtask${completed === 1 ? '' : 's'}${subtasks.length > completed ? ` of ${subtasks.length}` : ''}`;
  return `${subtasks.length} subtask${subtasks.length === 1 ? '' : 's'}`;
}

function finalizeParent(parent: MutableParentTask): TaskDashboardItem {
  const subtasks = Array.from(parent.subtasksByKey.values())
    .sort((left, right) => left.sequence - right.sequence)
    .map(({ nameKey: _nameKey, sequence: _sequence, ...subtask }) => subtask);
  const status = deriveParentStatus(parent, subtasks);
  const meta = statusMeta(status);
  const activeSubtaskCount = subtasks.filter((subtask) => subtask.status === 'active').length;

  return {
    id: parent.id,
    title: parent.title,
    summary: parentSummary(parent, subtasks),
    status,
    ...meta,
    target: parent.target,
    writeScope: parent.writeScope,
    live: parent.live || status === 'active',
    responseMessageId: parent.responseMessageId,
    artifactIds: parent.artifactIds,
    timeLabel: parent.timeLabel,
    durationLabel: parent.durationLabel,
    startedAtMs: parent.startedAtMs,
    subtasks,
    subtaskCount: subtasks.length,
    activeSubtaskCount,
  };
}

export function buildTaskActivityDashboard({ messages, liveTurn }: DashboardInput): TaskActivityDashboard {
  const parents: MutableParentTask[] = [];
  const parentsByTurnId = new Map<string, MutableParentTask>();
  const parentsByMergeKey = new Map<string, MutableParentTask>();
  let toolSequence = 0;

  const ensureParent = (turnWithSequence: TurnWithSequence) => {
    const existing = parentsByTurnId.get(turnWithSequence.turn.id);
    if (existing) return existing;

    const parent = createParentTask(turnWithSequence);
    if (parent.mergeKey) {
      const existingByMergeKey = parentsByMergeKey.get(parent.mergeKey);
      if (existingByMergeKey) {
        mergeParentTask(existingByMergeKey, parent);
        parentsByTurnId.set(turnWithSequence.turn.id, existingByMergeKey);
        return existingByMergeKey;
      }
      parentsByMergeKey.set(parent.mergeKey, parent);
    }

    parentsByTurnId.set(turnWithSequence.turn.id, parent);
    parents.push(parent);
    return parent;
  };

  for (const turnWithSequence of collectTurns(messages, liveTurn)) {
    let currentParent: MutableParentTask | null = null;
    if ((turnWithSequence.live && !turnWithSequence.turn.completed) || titleFromToolArguments(turnWithSequence.turn.tools) || generatedArtifactIdsFromTurn(turnWithSequence.turn).length > 0) {
      currentParent = ensureParent(turnWithSequence);
    }

    for (const tool of turnWithSequence.turn.tools) {
      const items = subtaskItems({ ...turnWithSequence, tool, toolSequence: toolSequence++ });
      for (const item of items) {
        const parent = findExistingSubtaskParent(parents, item) ?? currentParent ?? ensureParent(turnWithSequence);
        upsertSubtask(parent, item);
        currentParent = parent;
      }
    }
  }

  const tasks = parents
    .sort((left, right) => left.sequence - right.sequence)
    .map(finalizeParent);
  const activeCount = tasks.filter((task) => task.status === 'active').length;
  const completedCount = tasks.filter((task) => task.status === 'completed').length;

  return {
    tasks,
    activeCount,
    completedCount,
    totalCount: tasks.length,
    hasActivity: tasks.length > 0,
  };
}
