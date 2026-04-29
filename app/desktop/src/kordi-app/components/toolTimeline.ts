export type ToolTimelineInput = {
  name: string;
  status?: string | null;
  arguments?: string | null;
  detail?: string | null;
  isError?: boolean;
};

export type ToolTimelineSummaryInput = {
  tools: ToolTimelineInput[];
  active: boolean;
  completed: boolean;
  thinkingText?: string;
};

export type ToolTimelineFoldedLabelInput = ToolTimelineSummaryInput;

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

function pathFromTool(tool: ToolTimelineInput) {
  return firstStringValue(safeParseToolArguments(tool.arguments), ['path', 'file', 'file_path', 'target_file', 'relative_path']);
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

export function toolTimelineTypeLabel(tool: ToolTimelineInput) {
  const normalized = normalizedToolName(tool.name);

  if (normalized === 'reach_out') return 'Message';
  if (normalized.includes('web_fetch') || normalized.includes('browser_fetch')) return 'Web';
  if (normalized.includes('search') || normalized.includes('grep')) return 'Search';
  if (normalized.includes('read') || normalized.includes('view') || normalized.includes('cat')) return 'Read';
  if (normalized.includes('list') || normalized.includes('glob') || normalized.includes('find') || normalized.includes('dir')) return 'Browse';
  if (normalized.includes('bash') || normalized.includes('shell') || normalized.includes('command') || normalized.includes('terminal')) return 'Script';
  if (normalized.includes('edit') || normalized.includes('write') || normalized.includes('patch')) return 'Edit';
  if (normalized.includes('image')) return 'Image';

  return 'Tool';
}

export function toolTimelineToolLabel(tool: ToolTimelineInput) {
  const normalized = normalizedToolName(tool.name);
  const command = commandFromTool(tool);
  const path = pathFromTool(tool);

  if (normalized === 'reach_out') return 'Contact participant';
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

export function formatRunningElapsed(elapsedMs: number) {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

export function toolTimelineSummary({ tools, active, completed, thinkingText }: ToolTimelineSummaryInput) {
  const failedCount = tools.filter(timelineToolFailed).length;
  const runningCount = tools.filter((tool) => !timelineToolDone(tool) && !timelineToolFailed(tool)).length;

  if (failedCount > 0) return 'Tool use needs attention';
  if (active || runningCount > 0 || !completed) return 'Thinking and tool use · running…';
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

function activeToolLabel(tool: ToolTimelineInput) {
  const typeLabel = toolTimelineTypeLabel(tool);
  if (typeLabel === 'Script') return 'Running command';
  if (typeLabel === 'Search') return 'Searching';
  if (typeLabel === 'Read') return 'Reading';
  if (typeLabel === 'Edit') return 'Editing';
  if (typeLabel === 'Web') return 'Fetching';
  return `Using ${typeLabel.toLowerCase()}`;
}

export function toolTimelineFoldedLabel({ tools, active, completed, thinkingText }: ToolTimelineFoldedLabelInput) {
  const failedCount = tools.filter(timelineToolFailed).length;
  if (failedCount > 0) return 'Tool use needs attention';

  const phrase = thinkingPhrase(thinkingText ?? '');
  const runningTool = tools.find((tool) => !timelineToolDone(tool) && !timelineToolFailed(tool));

  if (active || runningTool) {
    if (phrase) return `Thinking about ${lowerCaseFirstLetter(phrase)}`;
    if (runningTool) return activeToolLabel(runningTool);
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
