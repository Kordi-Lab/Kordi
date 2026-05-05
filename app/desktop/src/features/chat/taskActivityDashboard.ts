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
};

export type TaskDashboardSubtask = TaskDashboardBase;

export type TaskDashboardItem = TaskDashboardBase & {
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
  completed: boolean;
  succeeded: boolean;
  message: string;
  assistantText: string;
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

function compact(value: string, maxLength = 180) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function titleFromPrompt(prompt: string) {
  const withoutLeadingMention = prompt.replace(/^\s*(?:@\S+\s+)+/, '').trim();
  return compact(withoutLeadingMention || prompt || 'Current task', 96);
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
      turns.push({ turn: message.turn, live: false, sequence: sequence++ });
    }
  }

  if (liveTurn && !liveTurn.completed) {
    turns.push({ turn: liveTurn, live: true, sequence: sequence++ });
  }

  return turns;
}

function createParentTask({ turn, live, sequence }: TurnWithSequence): MutableParentTask {
  const status: TaskDashboardStatus = live && !turn.completed ? 'active' : turn.completed && turn.succeeded ? 'completed' : 'failed';
  return {
    id: `turn:${turn.id}`,
    title: titleFromToolArguments(turn.tools) ?? titleFromPrompt(turn.prompt),
    summary: compact(turn.message || turn.assistantText || ''),
    status,
    ...statusMeta(status),
    target: null,
    writeScope: [],
    live,
    sequence,
    completed: turn.completed,
    succeeded: turn.succeeded,
    message: turn.message,
    assistantText: turn.assistantText,
    subtasksByKey: new Map(),
  };
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
    subtasks,
    subtaskCount: subtasks.length,
    activeSubtaskCount,
  };
}

export function buildTaskActivityDashboard({ messages, liveTurn }: DashboardInput): TaskActivityDashboard {
  const parents: MutableParentTask[] = [];
  const parentsByTurnId = new Map<string, MutableParentTask>();
  let toolSequence = 0;

  const ensureParent = (turnWithSequence: TurnWithSequence) => {
    const existing = parentsByTurnId.get(turnWithSequence.turn.id);
    if (existing) return existing;
    const parent = createParentTask(turnWithSequence);
    parentsByTurnId.set(turnWithSequence.turn.id, parent);
    parents.push(parent);
    return parent;
  };

  for (const turnWithSequence of collectTurns(messages, liveTurn)) {
    let currentParent: MutableParentTask | null = null;
    if ((turnWithSequence.live && !turnWithSequence.turn.completed) || titleFromToolArguments(turnWithSequence.turn.tools)) {
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
