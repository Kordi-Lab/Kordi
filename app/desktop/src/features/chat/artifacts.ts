import type { DesktopChatTurnSnapshot, Message, SessionArtifact } from '@/kordi-app/types';

const CODE_EXTENSIONS = new Set([
  'c', 'cc', 'cpp', 'cs', 'css', 'go', 'h', 'hpp', 'html', 'java', 'js', 'json', 'jsx', 'kt', 'mjs', 'php', 'py', 'rb', 'rs', 'scss', 'sh', 'sql', 'swift', 'toml', 'ts', 'tsx', 'vue', 'xml', 'yaml', 'yml',
]);

const DOCUMENT_EXTENSIONS = new Set([
  'adoc', 'csv', 'ipynb', 'markdown', 'md', 'mdx', 'pdf', 'rst', 'rtf', 'txt',
]);

type StoredArtifact = SessionArtifact & { order: number };

type SessionArtifactCategory = NonNullable<SessionArtifact['category']>;

type CollectedArtifactPath = {
  path: string;
  category: SessionArtifactCategory;
};

const GENERATED_ARTIFACT_SEGMENTS = new Set([
  'artifact', 'artifacts', 'deliverable', 'deliverables', 'report', 'reports', 'output', 'outputs', 'prototype', 'prototypes', 'dashboard', 'dashboards',
]);

const GENERATED_ARTIFACT_NAME_TERMS = [
  'artifact', 'report', 'summary', 'brief', 'spec', 'proposal', 'dashboard', 'prototype', 'visualization', 'contract', 'agreement', 'clause', 'notice',
];

const RELATED_METADATA_FILE_NAMES = new Set([
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'cargo.toml', 'cargo.lock', 'tsconfig.json', 'vite.config.ts', 'vite.config.js', '.gitignore',
]);

export function normalizeSessionArtifactId(path: string) {
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

function isRelatedFileTool(toolName: string) {
  const normalized = toolName.trim().toLowerCase();
  return isGeneratedArtifactTool(normalized)
    || normalized.includes('read')
    || normalized.includes('open')
    || normalized.includes('view')
    || normalized.includes('file');
}

function pathSegments(path: string) {
  return normalizeSessionArtifactId(path).toLowerCase().split('/').filter(Boolean);
}

function fileNameFromPath(path: string) {
  return pathSegments(path).pop() ?? '';
}

function pathExtension(path: string) {
  const fileName = fileNameFromPath(path);
  const extension = fileName.split('.').pop()?.trim().toLowerCase();
  return extension && extension !== fileName ? extension : '';
}

function isImplementationSourcePath(path: string) {
  const segments = pathSegments(path);
  if (segments.some((segment) => ['src', 'test', 'tests', '__tests__'].includes(segment))) return true;

  const extension = pathExtension(path);
  return CODE_EXTENSIONS.has(extension)
    && segments.some((segment) => ['agent', 'app', 'components', 'crates', 'features', 'lib', 'pages', 'packages', 'scripts'].includes(segment));
}

function isReflectionLessonPath(path: string) {
  const normalized = normalizeSessionArtifactId(path).toLowerCase();
  return normalized.includes('/reflection-lessons/') || normalized.includes('reflection-lessons/');
}

function isSkillPath(path: string) {
  const segments = pathSegments(path);
  return segments.includes('skills') || fileNameFromPath(path) === 'skill.md';
}

function isPackageOrConfigPath(path: string) {
  const fileName = fileNameFromPath(path);
  return RELATED_METADATA_FILE_NAMES.has(fileName)
    || /^.+\.config\.[cm]?[jt]s$/.test(fileName)
    || /^\.?[a-z0-9_-]+rc(?:\..+)?$/.test(fileName);
}

function pathLooksLikeGeneratedArtifact(path: string) {
  if (isReflectionLessonPath(path) || isSkillPath(path) || isPackageOrConfigPath(path) || isImplementationSourcePath(path)) return false;

  const segments = pathSegments(path);
  if (segments.some((segment) => GENERATED_ARTIFACT_SEGMENTS.has(segment))) return true;

  const fileName = fileNameFromPath(path);
  if (GENERATED_ARTIFACT_NAME_TERMS.some((term) => fileName.includes(term))) return true;

  const extension = pathExtension(path);
  return ['html', 'pdf', 'svg', 'ipynb'].includes(extension) && !segments.includes('src');
}

export function sessionArtifactCategoryForToolPath(toolName: string, path: string, explicitArtifactPath = false): SessionArtifactCategory {
  const normalizedTool = toolName.trim().toLowerCase();
  if (normalizedTool === 'reflection' || isReflectionLessonPath(path)) return 'memory';
  if (isSkillPath(path) || isPackageOrConfigPath(path) || isImplementationSourcePath(path)) return 'related';
  if (isGeneratedArtifactTool(normalizedTool) && (explicitArtifactPath || pathLooksLikeGeneratedArtifact(path))) return 'artifact';
  return 'related';
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

function collectToolArtifactPaths(toolName: string, argumentsJson: string): CollectedArtifactPath[] {
  if (!isRelatedFileTool(toolName)) return [];

  const parsed = parseToolArguments(argumentsJson);
  if (!parsed) return [];

  const paths = ['path', 'file_path', 'filepath', 'file', 'target_file']
    .map((key) => parsed[key])
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean);

  return Array.from(new Set(paths)).map((path) => ({
    path,
    category: sessionArtifactCategoryForToolPath(toolName, path),
  }));
}

function buildArtifactSummary(toolName: string, live: boolean, category: SessionArtifactCategory) {
  const normalized = toolName.trim().toLowerCase();
  if (category === 'memory') {
    return live ? 'Scoped reflection memory • in progress' : 'Scoped reflection memory';
  }
  if (category === 'related') {
    return live ? `Related file from ${toolName} • in progress` : `Related file from ${toolName}`;
  }
  const action = normalized.includes('edit') || normalized.includes('patch') ? 'Updated artifact with' : 'Created artifact with';
  return live ? `${action} ${toolName} • in progress` : `${action} ${toolName}`;
}

function upsertArtifact(
  byId: Map<string, StoredArtifact>,
  path: string,
  order: number,
  summary: string,
  category: SessionArtifactCategory,
  timeLabel?: string,
  live = false,
  pinned = false,
) {
  const normalizedId = normalizeSessionArtifactId(path);
  if (!normalizedId) return;

  const existing = byId.get(normalizedId);
  if (existing?.pinned && existing.order > order) return;
  if (existing?.category === 'artifact' && category !== 'artifact') return;

  const name = normalizedId.split('/').pop() || normalizedId;
  byId.set(normalizedId, {
    id: normalizedId,
    path,
    name,
    kind: classifyArtifactKind(normalizedId),
    category,
    summary,
    timeLabel,
    live,
    pinned,
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

    const paths: CollectedArtifactPath[] = [
      ...collectToolArtifactPaths(tool.name, tool.arguments),
      ...(tool.artifactPath?.trim()
        ? [{ path: tool.artifactPath.trim(), category: sessionArtifactCategoryForToolPath(tool.name, tool.artifactPath.trim(), true) }]
        : []),
    ];

    const seen = new Set<string>();
    paths.forEach(({ path, category }) => {
      const id = normalizeSessionArtifactId(path);
      if (!id || seen.has(id)) return;
      seen.add(id);
      upsertArtifact(
        byId,
        path,
        startOrder + index,
        buildArtifactSummary(tool.name, artifactLive, category),
        category,
        timeLabel,
        artifactLive,
      );
    });
  });
}

function collectPinnedArtifacts(byId: Map<string, StoredArtifact>, pinnedArtifacts: SessionArtifact[]) {
  pinnedArtifacts.forEach((artifact, index) => {
    const normalizedId = normalizeSessionArtifactId(artifact.path);
    if (!normalizedId) return;
    byId.set(normalizedId, {
      ...artifact,
      id: artifact.id || normalizedId,
      category: artifact.category ?? sessionArtifactCategoryForToolPath('pinned', artifact.path, true),
      pinned: true,
      timeLabel: artifact.timeLabel ?? 'Pinned',
      order: 1_000_000 - index,
    });
  });
}

export function generatedArtifactIdsFromTurn(turn: DesktopChatTurnSnapshot) {
  const artifactIds: string[] = [];
  const seen = new Set<string>();

  for (const tool of turn.tools) {
    const paths: CollectedArtifactPath[] = [
      ...collectToolArtifactPaths(tool.name, tool.arguments),
      ...(tool.artifactPath?.trim()
        ? [{ path: tool.artifactPath.trim(), category: sessionArtifactCategoryForToolPath(tool.name, tool.artifactPath.trim(), true) }]
        : []),
    ];

    for (const { path, category } of paths) {
      const id = normalizeSessionArtifactId(path);
      if (category !== 'artifact' || !id || seen.has(id)) continue;
      seen.add(id);
      artifactIds.push(id);
    }
  }

  return artifactIds;
}

function categorySortPriority(category: SessionArtifactCategory) {
  switch (category) {
    case 'artifact':
      return 0;
    case 'related':
      return 1;
    case 'memory':
      return 2;
    default:
      return 3;
  }
}

export function extractSessionArtifacts(
  messages: Message[],
  liveTurn?: DesktopChatTurnSnapshot | null,
  pinnedArtifacts: SessionArtifact[] = [],
): SessionArtifact[] {
  const byId = new Map<string, StoredArtifact>();
  collectPinnedArtifacts(byId, pinnedArtifacts);

  messages.forEach((message, index) => {
    const baseOrder = index * 10;

    if (message.edit?.files?.length) {
      message.edit.files.forEach((file, fileIndex) => {
        upsertArtifact(byId, file.path, baseOrder + fileIndex, 'Related edited file', 'related', message.time);
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
    .filter((artifact) => artifact.category === 'artifact')
    .sort((left, right) => categorySortPriority(left.category ?? 'artifact') - categorySortPriority(right.category ?? 'artifact') || right.order - left.order)
    .map(({ order: _order, ...artifact }) => artifact);
}
