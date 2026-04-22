import type { DesktopChatTurnSnapshot, Message, SessionArtifact } from '@/kordi-app/types';

const CODE_EXTENSIONS = new Set([
  'c', 'cc', 'cpp', 'cs', 'css', 'go', 'h', 'hpp', 'html', 'java', 'js', 'json', 'jsx', 'kt', 'mjs', 'php', 'py', 'rb', 'rs', 'scss', 'sh', 'sql', 'swift', 'toml', 'ts', 'tsx', 'vue', 'xml', 'yaml', 'yml',
]);

const DOCUMENT_EXTENSIONS = new Set([
  'adoc', 'csv', 'ipynb', 'markdown', 'md', 'mdx', 'pdf', 'rst', 'rtf', 'txt',
]);

type StoredArtifact = SessionArtifact & { order: number };

function normalizeArtifactId(path: string) {
  return path.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function classifyArtifactKind(path: string): SessionArtifact['kind'] {
  const extension = path.split('.').pop()?.trim().toLowerCase();
  if (!extension) return 'file';
  if (CODE_EXTENSIONS.has(extension)) return 'code';
  if (DOCUMENT_EXTENSIONS.has(extension)) return 'document';
  return 'file';
}

function isGeneratedArtifactTool(toolName: string) {
  const normalized = toolName.trim().toLowerCase();
  return normalized.includes('write') || normalized.includes('edit') || normalized.includes('patch');
}

function parseToolArguments(raw: string) {
  if (!raw.trim()) return null;

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function collectToolArtifactPaths(toolName: string, argumentsJson: string) {
  if (!isGeneratedArtifactTool(toolName)) return [];

  const parsed = parseToolArguments(argumentsJson);
  const path = typeof parsed?.path === 'string' ? parsed.path.trim() : '';
  return path ? [path] : [];
}

function buildArtifactSummary(toolName: string, live: boolean) {
  const normalized = toolName.trim().toLowerCase();
  const action = normalized.includes('edit') || normalized.includes('patch') ? 'Updated with' : 'Created with';
  return live ? `${action} ${toolName} • in progress` : `${action} ${toolName}`;
}

function upsertArtifact(
  byId: Map<string, StoredArtifact>,
  path: string,
  order: number,
  summary: string,
  timeLabel?: string,
  live = false,
) {
  const normalizedId = normalizeArtifactId(path);
  if (!normalizedId) return;

  const name = normalizedId.split('/').pop() || normalizedId;
  byId.set(normalizedId, {
    id: normalizedId,
    path,
    name,
    kind: classifyArtifactKind(normalizedId),
    summary,
    timeLabel,
    live,
    order,
  });
}

function collectTurnArtifacts(
  byId: Map<string, StoredArtifact>,
  turn: DesktopChatTurnSnapshot,
  startOrder: number,
  timeLabel: string | undefined,
  live: boolean,
) {
  turn.tools.forEach((tool, index) => {
    const artifactLive = live && tool.status !== 'done' && tool.status !== 'error';

    collectToolArtifactPaths(tool.name, tool.arguments).forEach((path) => {
      upsertArtifact(
        byId,
        path,
        startOrder + index,
        buildArtifactSummary(tool.name, artifactLive),
        timeLabel,
        artifactLive,
      );
    });
  });
}

export function extractSessionArtifacts(messages: Message[], liveTurn?: DesktopChatTurnSnapshot | null): SessionArtifact[] {
  const byId = new Map<string, StoredArtifact>();

  messages.forEach((message, index) => {
    const baseOrder = index * 10;

    if (message.edit?.files?.length) {
      message.edit.files.forEach((file, fileIndex) => {
        upsertArtifact(byId, file.path, baseOrder + fileIndex, 'Edited in this session', message.time);
      });
    }

    if (message.turn) {
      collectTurnArtifacts(byId, message.turn, baseOrder + 5, message.time, false);
    }
  });

  if (liveTurn) {
    collectTurnArtifacts(byId, liveTurn, messages.length * 10 + 5, undefined, true);
  }

  return Array.from(byId.values())
    .sort((left, right) => right.order - left.order)
    .map(({ order: _order, ...artifact }) => artifact);
}
