export type ToolTimelineInput = {
  name: string;
  status?: string | null;
  arguments?: string | null;
  detail?: string | null;
  toolLayer?: string | null;
  isError?: boolean;
};

export type ToolTimelineSummaryInput = {
  tools: ToolTimelineInput[];
  active: boolean;
  completed: boolean;
  thinkingText?: string;
};

export type ToolTimelineFoldedLabelInput = ToolTimelineSummaryInput & {
  runningElapsed?: string | null;
};

// Historical transcripts can contain this retired tool name.
export const LEGACY_PARTICIPANT_REQUEST_TOOL_NAME = 'reach_out';

function normalizedToolName(toolName: string) {
  return toolName.trim().toLowerCase();
}

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

function firstStringValue(record: Record<string, unknown> | null, keys: string[]) {
  if (!record) return '';
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function commandFromTool(tool: ToolTimelineInput) {
  return firstStringValue(safeParseToolArguments(tool.arguments), ['command', 'cmd', 'script', 'input']);
}

const TOOL_PATH_ARGUMENT_KEYS = ['path', 'file', 'file_path', 'target_file', 'relative_path'];

function pathFromTool(tool: ToolTimelineInput) {
  return firstStringValue(safeParseToolArguments(tool.arguments), TOOL_PATH_ARGUMENT_KEYS);
}

function searchQueryFromTool(tool: ToolTimelineInput) {
  return firstStringValue(safeParseToolArguments(tool.arguments), ['query', 'pattern', 'regex', 'term', 'search', 'input']);
}

function urlFromTool(tool: ToolTimelineInput) {
  return firstStringValue(safeParseToolArguments(tool.arguments), ['url', 'uri', 'href', 'link']);
}

function inlineToolDetail(value: string, maxLength = 96) {
  const compactValue = value.replace(/\s+/g, ' ').trim();
  if (compactValue.length <= maxLength) return compactValue;
  return `${compactValue.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

type TimelinePathTarget = {
  label: string;
  kind: 'path' | 'attached-image';
};

function fileNameFromPath(path: string) {
  return path.trim().split(/[\\/]/).filter(Boolean).pop() ?? '';
}

function isTemporaryClipboardImagePath(path: string) {
  const fileName = fileNameFromPath(path);
  return /^pi-clipboard-[\w-]+\.(?:png|jpe?g|gif|webp|avif|heic|heif)$/i.test(fileName);
}

function timelinePathTarget(path: string): TimelinePathTarget | null {
  const trimmed = path.trim();
  if (!trimmed) return null;
  if (isTemporaryClipboardImagePath(trimmed)) {
    return { label: 'attached image', kind: 'attached-image' };
  }
  return { label: inlineToolDetail(trimmed), kind: 'path' };
}

export function toolTimelineDisplayArguments(tool: ToolTimelineInput) {
  const rawArguments = tool.arguments ?? '';
  const parsed = safeParseToolArguments(rawArguments);
  if (!parsed) return rawArguments;

  let changed = false;
  const sanitized = { ...parsed };
  for (const key of TOOL_PATH_ARGUMENT_KEYS) {
    const value = sanitized[key];
    if (typeof value === 'string' && timelinePathTarget(value)?.kind === 'attached-image') {
      sanitized[key] = '[attached image]';
      changed = true;
    }
  }

  return changed ? JSON.stringify(sanitized, null, 2) : rawArguments;
}

function normalizedCommand(command: string) {
  return command.trim().replace(/^\s*(?:pnpm|npm|yarn|bun)\s+(?:--dir\s+\S+\s+)?/, '').toLowerCase();
}

function labelForShellCommand(command: string) {
  const normalized = normalizedCommand(command);
  const firstToken = normalized.split(/\s+/)[0] ?? '';

  if (/\b(?:df|du)\b/.test(normalized)) return 'Check disk usage';
  if (firstToken === 'pwd') return 'Check working directory';
  if (/\b(?:rg|grep|ag)\b/.test(normalized)) return 'Search code';
  if (/\b(?:find|fd)\b/.test(normalized)) return 'Find files';
  if (/\b(?:ls|tree)\b/.test(normalized)) return 'List files';
  if (/\b(?:cat|sed|head|tail|less)\b/.test(normalized)) return 'Inspect file';
  if (/\b(?:git status|git diff|git log|git show)\b/.test(normalized)) return 'Inspect repository';
  if (/\b(?:git fetch|git pull)\b/.test(normalized)) return 'Update repository';
  if (/\b(?:test|vitest|jest|tsx --test|cargo test|go test|pytest)\b/.test(normalized)) return 'Run tests';
  if (/\b(?:lint|eslint|biome|ruff|clippy)\b/.test(normalized)) return 'Run lint';
  if (/\b(?:typecheck|tsc|mypy)\b/.test(normalized)) return 'Run typecheck';
  if (/\b(?:build|vite build|next build|cargo build)\b/.test(normalized)) return 'Build project';

  return 'Run script';
}

function normalizedLayerValue(value?: string | null) {
  return value
    ?.trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase() ?? '';
}

function layerLabelFromValue(value?: string | null) {
  switch (normalizedLayerValue(value)) {
    case 'observation':
      return 'Observation';
    case 'planning':
      return 'Planning';
    case 'operator':
      return 'Operator';
    case 'execution':
      return 'Execution';
    case 'reflection':
      return 'Reflection';
    default:
      return null;
  }
}

export function toolTimelineTypeLabel(tool: ToolTimelineInput) {
  const explicitLayer = layerLabelFromValue(tool.toolLayer);
  if (explicitLayer) return explicitLayer;

  const normalized = normalizedToolName(tool.name);

  if (normalized === 'reflection') return 'Reflection';
  if (normalized === 'update_plan') return 'Planning';
  if (normalized === 'task_operator' || normalized === LEGACY_PARTICIPANT_REQUEST_TOOL_NAME) return 'Operator';
  if (normalized.includes('bash') || normalized.includes('shell') || normalized.includes('command') || normalized.includes('terminal')) return 'Execution';
  if (normalized.includes('edit') || normalized.includes('write') || normalized.includes('patch')) return 'Execution';

  return 'Observation';
}

export function toolTimelineToolLabel(tool: ToolTimelineInput) {
  const normalized = normalizedToolName(tool.name);
  const command = commandFromTool(tool);
  const path = pathFromTool(tool);

  if (normalized === LEGACY_PARTICIPANT_REQUEST_TOOL_NAME) return 'Contact participant';
  if (normalized === 'update_plan') return 'Update plan';
  if (normalized === 'task_operator') return 'Coordinate task';
  if (normalized === 'reflection') return 'Save lesson';
  if (normalized.includes('bash') || normalized.includes('shell') || normalized.includes('command') || normalized.includes('terminal')) {
    return command ? labelForShellCommand(command) : 'Run script';
  }
  if (normalized.includes('search') || normalized.includes('grep')) return 'Search code';
  if (normalized.includes('read') || normalized.includes('view') || normalized.includes('cat')) return path ? 'Read file' : 'Read context';
  if (normalized.includes('list') || normalized.includes('glob') || normalized.includes('find') || normalized.includes('dir')) return 'Find files';
  if (normalized.includes('edit') || normalized.includes('write') || normalized.includes('patch')) return path ? 'Edit file' : 'Edit files';
  if (normalized.includes('web_fetch') || normalized.includes('browser_fetch')) return 'Fetch web page';
  if (normalized.includes('image')) return 'Inspect image';

  return tool.name;
}

function normalizedToolStatus(tool: ToolTimelineInput) {
  return (tool.isError ? 'error' : tool.status || 'pending').trim().toLowerCase();
}

function timelineToolFailed(tool: ToolTimelineInput) {
  const status = normalizedToolStatus(tool);
  return tool.isError || status === 'error' || status.includes('failed');
}

function timelineToolDone(tool: ToolTimelineInput) {
  const status = normalizedToolStatus(tool);
  return !timelineToolFailed(tool) && (status === 'done' || status === 'complete' || status === 'completed');
}

export type ToolTimelineLayerGroup<T extends ToolTimelineInput = ToolTimelineInput> = {
  id: string;
  label: string;
  tools: T[];
  failed: boolean;
  running: boolean;
};

function layerGroupId(label: string) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'tools';
}

export function toolTimelineLayerGroups<T extends ToolTimelineInput>(tools: T[]): ToolTimelineLayerGroup<T>[] {
  const groups: ToolTimelineLayerGroup<T>[] = [];
  const groupByLabel = new Map<string, ToolTimelineLayerGroup<T>>();

  for (const tool of tools) {
    const label = toolTimelineTypeLabel(tool);
    let group = groupByLabel.get(label);
    if (!group) {
      group = {
        id: layerGroupId(label),
        label,
        tools: [],
        failed: false,
        running: false,
      };
      groupByLabel.set(label, group);
      groups.push(group);
    }
    group.tools.push(tool);
  }

  for (const group of groups) {
    group.failed = group.tools.some(timelineToolFailed);
    group.running = group.tools.some((tool) => !timelineToolDone(tool) && !timelineToolFailed(tool));
  }

  return groups;
}

export function formatRunningElapsed(elapsedMs: number) {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

export function toolTimelineFailureLabel(failedCount: number) {
  return `${failedCount} ${failedCount === 1 ? 'tool' : 'tools'} failed`;
}

export function toolTimelineSummary({ tools, active, completed, thinkingText }: ToolTimelineSummaryInput) {
  const failedCount = tools.filter(timelineToolFailed).length;
  const runningCount = tools.filter((tool) => !timelineToolDone(tool) && !timelineToolFailed(tool)).length;

  if (runningCount > 0 || (failedCount === 0 && (active || !completed))) return 'Thinking and tool use · running…';
  if (failedCount > 0) return toolTimelineFailureLabel(failedCount);
  if (tools.length > 0) return `Used ${tools.length} ${tools.length === 1 ? 'tool' : 'tools'} · completed`;
  if (thinkingText?.trim()) return 'Reasoning trace';
  return 'Assistant activity';
}

function cleanTimelinePhrase(value: string) {
  return value
    .trim()
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[.。]\s*$/, '')
    .trim();
}

function withoutTrailingSentencePunctuation(value: string) {
  return cleanTimelinePhrase(value);
}

function lowerCaseFirstLetter(value: string) {
  return value ? `${value.charAt(0).toLowerCase()}${value.slice(1)}` : value;
}

function thinkingPhrase(thinkingText: string) {
  const line = firstMeaningfulThinkingLine(thinkingText);
  if (line === 'Thinking through the request') return '';

  return withoutTrailingSentencePunctuation(line)
    .replace(/^the user\s+(?:wants|asked|needs|would like)\s+(?:me\s+)?(?:to\s+)?/i, '')
    .replace(/^i\s+(?:need|should|will|am going)\s+to\s+/i, '')
    .replace(/^we\s+(?:need|should|will)\s+to\s+/i, '')
    .trim();
}

export function toolTimelineRunningToolLabel(tool: ToolTimelineInput) {
  const normalized = normalizedToolName(tool.name);
  const command = commandFromTool(tool);
  const path = pathFromTool(tool);
  const pathTarget = timelinePathTarget(path);
  const searchQuery = searchQueryFromTool(tool);
  const url = urlFromTool(tool);

  if (normalized === LEGACY_PARTICIPANT_REQUEST_TOOL_NAME) return 'Contacting participant';
  if (normalized === 'update_plan') return 'Updating plan';
  if (normalized === 'task_operator') return 'Coordinating task';
  if (normalized === 'reflection') return 'Saving lesson';
  if (normalized.includes('bash') || normalized.includes('shell') || normalized.includes('command') || normalized.includes('terminal')) {
    return command ? `Running command: ${inlineToolDetail(command)}` : 'Running command';
  }
  if (normalized.includes('search') || normalized.includes('grep')) return searchQuery ? `Searching: ${inlineToolDetail(searchQuery)}` : 'Searching';
  if (normalized.includes('read') || normalized.includes('view') || normalized.includes('cat')) {
    if (pathTarget?.kind === 'attached-image') return 'Reading attached image';
    return pathTarget ? `Reading file: ${pathTarget.label}` : 'Reading';
  }
  if (normalized.includes('edit') || normalized.includes('write') || normalized.includes('patch')) return pathTarget ? `Editing file: ${pathTarget.label}` : 'Editing';
  if (normalized.includes('web_fetch') || normalized.includes('browser_fetch')) return url ? `Fetching URL: ${inlineToolDetail(url)}` : 'Fetching';
  if (normalized.includes('list') || normalized.includes('glob') || normalized.includes('find') || normalized.includes('dir')) return pathTarget ? `Finding files: ${pathTarget.label}` : 'Finding files';
  if (normalized.includes('image')) {
    if (pathTarget?.kind === 'attached-image') return 'Inspecting attached image';
    return pathTarget ? `Inspecting image: ${pathTarget.label}` : 'Inspecting image';
  }
  return `Using ${toolTimelineTypeLabel(tool).toLowerCase()} tool`;
}

export function toolTimelineRunningPreviewLabel(tool: ToolTimelineInput, runningElapsed?: string | null) {
  const actionLabel = lowerCaseFirstLetter(toolTimelineRunningToolLabel(tool));
  const label = `${toolTimelineTypeLabel(tool)}: ${actionLabel}`;
  const elapsed = runningElapsed?.trim();
  return elapsed ? `${label} · ${elapsed}` : label;
}

export function toolTimelineFoldedLabel({ tools, active, completed, thinkingText, runningElapsed }: ToolTimelineFoldedLabelInput) {
  const failedCount = tools.filter(timelineToolFailed).length;
  const phrase = thinkingPhrase(thinkingText ?? '');
  const runningTool = tools.find((tool) => !timelineToolDone(tool) && !timelineToolFailed(tool));

  if (runningTool) return toolTimelineRunningPreviewLabel(runningTool, runningElapsed);

  if (failedCount > 0) return toolTimelineFailureLabel(failedCount);

  if (active) {
    if (phrase) return `Thinking about ${lowerCaseFirstLetter(phrase)}`;
    return 'Thinking';
  }

  if (completed && phrase) return withoutTrailingSentencePunctuation(phrase);
  return toolTimelineSummary({ tools, active, completed, thinkingText });
}

export function firstMeaningfulThinkingLine(thinkingText: string) {
  const line = thinkingText
    .split('\n')
    .map((value) => value.trim().replace(/^[-*]\s+/, ''))
    .find((value) => value.length > 0);

  if (!line) return 'Thinking through the request';
  const compactLine = cleanTimelinePhrase(line);
  return compactLine.length > 96 ? `${compactLine.slice(0, 93).trimEnd()}…` : compactLine;
}
