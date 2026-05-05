import type { DesktopChatToolSnapshot, DesktopChatTurnSnapshot, Message } from '@/kordi-app/types';

export type TaskDashboardStatus = 'planned' | 'active' | 'completed' | 'failed' | 'closed';
export type TaskDashboardTone = 'muted' | 'running' | 'success' | 'error' | 'closed';

export type TaskDashboardItem = {
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

type ToolWithTurn = {
  tool: DesktopChatToolSnapshot;
  live: boolean;
  sequence: number;
};

type MutableTask = TaskDashboardItem & {
  nameKey?: string | null;
  sequence: number;
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

function statusMeta(status: TaskDashboardStatus): Pick<TaskDashboardItem, 'statusLabel' | 'tone'> {
  switch (status) {
    case 'active':
      return { statusLabel: 'Subagent active', tone: 'running' };
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

function matchingExistingKey(
  tasksByKey: Map<string, MutableTask>,
  target: string | null | undefined,
  nameKey: string | null | undefined,
) {
  const targetKey = target?.trim() ? `target:${target.trim()}` : null;
  if (targetKey && tasksByKey.has(targetKey)) return targetKey;

  const name = nameKey?.trim();
  if (!name) return null;
  const nameLookup = `name:${name}`;
  if (tasksByKey.has(nameLookup)) return nameLookup;

  for (const [key, task] of tasksByKey) {
    if (task.nameKey === name || task.target?.split('/').filter(Boolean).pop() === name) {
      return key;
    }
  }

  return null;
}

function upsertTask(tasksByKey: Map<string, MutableTask>, next: MutableTask) {
  const existingKey = matchingExistingKey(tasksByKey, next.target, next.nameKey);
  const key = existingKey ?? taskKey(next.target, next.nameKey, next.id);
  const existing = tasksByKey.get(key);
  const merged: MutableTask = existing
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

  if (existingKey && existingKey !== taskKey(next.target, next.nameKey, next.id)) {
    tasksByKey.delete(existingKey);
  }
  tasksByKey.set(taskKey(merged.target, merged.nameKey, merged.id), merged);
}

function manifestTasks(args: Record<string, unknown>, sequence: number, live: boolean): MutableTask[] {
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
      ...statusMeta('planned'),
      target: null,
      writeScope,
      live,
      sequence,
    }];
  });
}

function spawnTask(tool: DesktopChatToolSnapshot, args: Record<string, unknown>, sequence: number, live: boolean): MutableTask | null {
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
    ...statusMeta(status),
    target,
    writeScope: stringArrayValue(args.writeScope),
    live,
    sequence,
  };
}

function resultTask(tool: DesktopChatToolSnapshot, args: Record<string, unknown>, sequence: number, live: boolean): MutableTask | null {
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
    ...statusMeta(status),
    target,
    writeScope: stringArrayValue(args.writeScope),
    live,
    sequence,
  };
}

function collectTools(messages: Message[], liveTurn?: DesktopChatTurnSnapshot | null) {
  const tools: ToolWithTurn[] = [];
  let sequence = 0;
  for (const message of messages) {
    const turn = message.turn;
    if (!turn) continue;
    for (const tool of turn.tools) {
      tools.push({ tool, live: false, sequence: sequence++ });
    }
  }

  if (liveTurn && !liveTurn.completed) {
    for (const tool of liveTurn.tools) {
      tools.push({ tool, live: true, sequence: sequence++ });
    }
  }

  return tools;
}

function taskOperatorItems({ tool, live, sequence }: ToolWithTurn): MutableTask[] {
  if (tool.name.trim().toLowerCase() !== 'task_operator') return [];
  const args = safeParseToolArguments(tool.arguments);
  if (!args) return [];

  const action = stringValue(args.action);
  if (action === 'manifest') return manifestTasks(args, sequence, live);
  if (action === 'spawn') {
    const task = spawnTask(tool, args, sequence, live);
    return task ? [task] : [];
  }

  const task = resultTask(tool, args, sequence, live);
  return task ? [task] : [];
}

export function buildTaskActivityDashboard({ messages, liveTurn }: DashboardInput): TaskActivityDashboard {
  const tasksByKey = new Map<string, MutableTask>();
  for (const tool of collectTools(messages, liveTurn)) {
    for (const item of taskOperatorItems(tool)) {
      upsertTask(tasksByKey, item);
    }
  }

  const tasks = Array.from(tasksByKey.values())
    .sort((left, right) => left.sequence - right.sequence)
    .map(({ nameKey: _nameKey, sequence: _sequence, ...task }) => task);
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
