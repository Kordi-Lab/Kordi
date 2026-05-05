import type { DesktopChatToolSnapshot, DesktopChatTurnSnapshot, Message } from '@/kordi-app/types';
import { toolTimelineToolLabel, toolTimelineTypeLabel } from '@/kordi-app/components/toolTimeline';

export type TaskActivityGroupId = 'planning_coordination' | 'execution';
export type TaskActivityStatus = 'pending' | 'running' | 'done' | 'active' | 'completed' | 'closed' | 'error';
export type TaskActivityTone = 'muted' | 'running' | 'ready' | 'success' | 'closed' | 'error';
export type SubagentStatus = 'active' | 'completed' | 'failed' | 'closed';

export type TaskActivityItem = {
  id: string;
  group: TaskActivityGroupId;
  groupLabel: string;
  toolName: string;
  title: string;
  detail: string;
  status: TaskActivityStatus;
  statusLabel: string;
  tone: TaskActivityTone;
  target?: string | null;
  writeScope: string[];
  live: boolean;
  subagent?: {
    target: string;
    name: string;
    status: SubagentStatus;
    statusLabel: string;
    writeScope: string[];
  };
};

export type TaskActivitySubagent = NonNullable<TaskActivityItem['subagent']>;

export type TaskActivityDashboard = {
  planningCoordination: TaskActivityItem[];
  execution: TaskActivityItem[];
  subagents: TaskActivitySubagent[];
  activeSubagents: TaskActivitySubagent[];
  activeExecutionCount: number;
  totalActivityCount: number;
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

const GROUP_LABELS: Record<TaskActivityGroupId, string> = {
  planning_coordination: 'Planning & coordination',
  execution: 'Execution',
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

function normalizedStatus(tool: DesktopChatToolSnapshot) {
  return (tool.isError ? 'error' : tool.status || 'pending').trim().toLowerCase();
}

function toolIsRunning(tool: DesktopChatToolSnapshot) {
  const status = normalizedStatus(tool);
  return !tool.isError && !['done', 'complete', 'completed', 'succeeded', 'success', 'error', 'failed'].includes(status);
}

function toolStatus(tool: DesktopChatToolSnapshot): Pick<TaskActivityItem, 'status' | 'statusLabel' | 'tone'> {
  if (tool.isError || /failed|error/.test(normalizedStatus(tool))) {
    return { status: 'error', statusLabel: 'Needs attention', tone: 'error' };
  }
  if (toolIsRunning(tool)) {
    return { status: 'running', statusLabel: 'Running', tone: 'running' };
  }
  return { status: 'done', statusLabel: 'Done', tone: 'ready' };
}

function groupForTool(tool: DesktopChatToolSnapshot): TaskActivityGroupId | null {
  const layer = toolTimelineTypeLabel({
    name: tool.name,
    status: tool.status,
    arguments: tool.arguments,
    toolLayer: tool.toolLayer,
    isError: tool.isError,
  });
  if (layer === 'Planning' || layer === 'Operator') return 'planning_coordination';
  if (layer === 'Execution') return 'execution';
  return null;
}

function compact(value: string, maxLength = 140) {
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

function taskOperatorSubagent(
  tool: DesktopChatToolSnapshot,
  args: Record<string, unknown> | null,
): TaskActivitySubagent | null {
  if (tool.name.trim().toLowerCase() !== 'task_operator') return null;

  const action = stringValue(args?.action);
  const resultText = tool.resultText ?? '';
  const target = stringValue(args?.target)
    || targetFromTaskResult(resultText)
    || (action === 'spawn' && stringValue(args?.taskName) ? `/root/${stringValue(args?.taskName)}` : null);
  if (!target) return null;

  const name = stringValue(args?.taskName) || targetName(target);
  const writeScope = stringArrayValue(args?.writeScope);
  const lowerResult = resultText.toLowerCase();

  if (tool.isError || lowerResult.includes('task failed')) {
    return { target, name, status: 'failed', statusLabel: 'Subagent failed', writeScope };
  }
  if (action === 'close' || lowerResult.includes('task agent closed')) {
    return { target, name, status: 'closed', statusLabel: 'Subagent closed', writeScope };
  }
  if (lowerResult.includes('task completed')) {
    return { target, name, status: 'completed', statusLabel: 'Subagent completed', writeScope };
  }
  if (action === 'spawn' || lowerResult.includes('task agent running') || toolIsRunning(tool)) {
    return { target, name, status: 'active', statusLabel: 'Subagent active', writeScope };
  }

  return null;
}

function taskOperatorStatus(
  tool: DesktopChatToolSnapshot,
  args: Record<string, unknown> | null,
  subagent: TaskActivitySubagent | null,
): Pick<TaskActivityItem, 'status' | 'statusLabel' | 'tone'> {
  if (subagent) {
    switch (subagent.status) {
      case 'active':
        return { status: 'active', statusLabel: 'Subagent active', tone: 'running' };
      case 'completed':
        return { status: 'completed', statusLabel: 'Subagent completed', tone: 'success' };
      case 'closed':
        return { status: 'closed', statusLabel: 'Subagent closed', tone: 'closed' };
      case 'failed':
        return { status: 'error', statusLabel: 'Subagent failed', tone: 'error' };
    }
  }

  const action = stringValue(args?.action);
  if (action === 'manifest') return { status: 'done', statusLabel: 'Manifest ready', tone: 'ready' };
  if (action === 'estimate') return { status: 'done', statusLabel: 'Estimate ready', tone: 'ready' };
  if (action === 'message') return { status: 'done', statusLabel: 'Message sent', tone: 'ready' };
  if (action === 'wait' && toolIsRunning(tool)) return { status: 'running', statusLabel: 'Waiting', tone: 'running' };
  return toolStatus(tool);
}

function taskOperatorTitle(args: Record<string, unknown> | null, subagent: TaskActivitySubagent | null) {
  const action = stringValue(args?.action);
  if (subagent) return subagent.name;
  if (action === 'manifest') return 'Task manifest';
  if (action === 'estimate') return 'Cost estimate';
  if (action === 'wait') return 'Wait for subagent';
  if (action === 'list') return 'List subagents';
  return 'Coordinate task';
}

function taskOperatorDetail(
  tool: DesktopChatToolSnapshot,
  args: Record<string, unknown> | null,
  subagent: TaskActivitySubagent | null,
) {
  const action = stringValue(args?.action);
  const parts = [
    action ? `task_operator/${action}` : 'task_operator',
    subagent?.target,
    compact(tool.resultText ?? ''),
  ].filter((value): value is string => Boolean(value && value.trim()));
  return parts.join(' · ');
}

function executionTitle(tool: DesktopChatToolSnapshot) {
  return toolTimelineToolLabel({
    name: tool.name,
    status: tool.status,
    arguments: tool.arguments,
    toolLayer: tool.toolLayer,
    isError: tool.isError,
  });
}

function executionDetail(tool: DesktopChatToolSnapshot, args: Record<string, unknown> | null) {
  const command = stringValue(args?.command) || stringValue(args?.cmd) || stringValue(args?.script);
  const path = stringValue(args?.path) || stringValue(args?.file) || stringValue(args?.file_path) || stringValue(args?.target_file);
  const result = compact(tool.resultText ?? tool.liveOutput ?? '');
  return [command, path, result].filter((value): value is string => Boolean(value && value.trim())).join(' · ');
}

function taskActivityItem({ tool, live, sequence }: ToolWithTurn): TaskActivityItem | null {
  const group = groupForTool(tool);
  if (!group) return null;

  const args = safeParseToolArguments(tool.arguments);
  const isTaskOperator = tool.name.trim().toLowerCase() === 'task_operator';
  const subagent = isTaskOperator ? taskOperatorSubagent(tool, args) : null;
  const status = isTaskOperator ? taskOperatorStatus(tool, args, subagent) : toolStatus(tool);
  const writeScope = subagent?.writeScope ?? stringArrayValue(args?.writeScope);

  return {
    id: `${sequence}:${tool.id}`,
    group,
    groupLabel: GROUP_LABELS[group],
    toolName: tool.name,
    title: isTaskOperator ? taskOperatorTitle(args, subagent) : executionTitle(tool),
    detail: isTaskOperator ? taskOperatorDetail(tool, args, subagent) : executionDetail(tool, args),
    target: subagent?.target ?? stringValue(args?.target),
    writeScope,
    live,
    subagent: subagent ?? undefined,
    ...status,
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

export function buildTaskActivityDashboard({ messages, liveTurn }: DashboardInput): TaskActivityDashboard {
  const items = collectTools(messages, liveTurn)
    .map(taskActivityItem)
    .filter((item): item is TaskActivityItem => Boolean(item));

  const planningCoordination = items.filter((item) => item.group === 'planning_coordination');
  const execution = items.filter((item) => item.group === 'execution');
  const subagentByTarget = new Map<string, TaskActivitySubagent>();

  for (const item of planningCoordination) {
    if (item.subagent) {
      const previous = subagentByTarget.get(item.subagent.target);
      subagentByTarget.set(item.subagent.target, {
        ...item.subagent,
        writeScope: item.subagent.writeScope.length > 0 ? item.subagent.writeScope : previous?.writeScope ?? [],
      });
    }
  }

  const subagents = Array.from(subagentByTarget.values());
  const activeSubagents = subagents.filter((subagent) => subagent.status === 'active');
  const activeExecutionCount = execution.filter((item) => item.status === 'running').length;
  const totalActivityCount = planningCoordination.length + execution.length;

  return {
    planningCoordination,
    execution,
    subagents,
    activeSubagents,
    activeExecutionCount,
    totalActivityCount,
    hasActivity: totalActivityCount > 0 || subagents.length > 0,
  };
}
