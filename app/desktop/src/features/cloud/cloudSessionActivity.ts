import { changedFileRowsFromTurn } from '@/features/chat/artifacts';
import { formatDesktopLastActiveLabel } from '@/lib/time';
import type { DesktopVisibleTaskRecord } from '@/lib/desktop';
import type { DesktopChatTurnSnapshot, SessionArtifact, SessionTaskActivity, SessionTaskParticipant } from '@/kordi-app/types';

import type {
  CloudArtifactActivity,
  CloudSessionActivity,
  CloudTaskActivity,
  UpsertCloudArtifactActivityInput,
  UpsertCloudTaskActivityInput,
} from './authClient';
import { cloudSessionActivityEqual } from './cloudSessionActivityEquality';

export type CloudSessionActivityStore = {
  tasksBySessionId: Record<string, CloudTaskActivity[]>;
  artifactsBySessionId: Record<string, CloudArtifactActivity[]>;
};

export const EMPTY_CLOUD_SESSION_ACTIVITY: CloudSessionActivityStore = {
  tasksBySessionId: {},
  artifactsBySessionId: {},
};

export type PublishCloudTaskActivityInput = UpsertCloudTaskActivityInput;
export type PublishCloudArtifactActivityInput = UpsertCloudArtifactActivityInput;

export type CloudActivityParticipantProfile = {
  accountId: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  role?: string | null;
};

export function cloudActivityStorageKey(accountId: string) {
  return `kordi.cloud.sessionActivity.v1:${accountId.trim()}`;
}

function browserLocalStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function nullableText(value: unknown): string | null {
  const text = cleanText(value);
  return text || null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown): string[] {
  return arrayValue(value).map(cleanText).filter(Boolean);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeTask(value: unknown): CloudTaskActivity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const sessionId = cleanText(record.sessionId);
  const taskId = cleanText(record.taskId);
  const title = cleanText(record.title);
  const createdByAccountId = cleanText(record.createdByAccountId);
  const updatedAt = cleanText(record.updatedAt);
  if (!sessionId || !taskId || !title || !createdByAccountId || !updatedAt) return null;
  return {
    taskActivityId: cleanText(record.taskActivityId) || `cloud-task:${sessionId}:${taskId}`,
    sessionId,
    taskId,
    title,
    summary: nullableText(record.summary),
    status: cleanText(record.status) || 'active',
    createdByAccountId,
    targetAccountId: nullableText(record.targetAccountId),
    participants: arrayValue(record.participants),
    artifactIds: stringArray(record.artifactIds),
    responseMessageId: nullableText(record.responseMessageId),
    createdAt: cleanText(record.createdAt) || updatedAt,
    updatedAt,
    archivedAt: nullableText(record.archivedAt),
  };
}

function normalizeArtifact(value: unknown): CloudArtifactActivity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const sessionId = cleanText(record.sessionId);
  const artifactId = cleanText(record.artifactId);
  const path = cleanText(record.path) || artifactId;
  const name = cleanText(record.name) || path.split('/').filter(Boolean).pop() || artifactId;
  const createdByAccountId = cleanText(record.createdByAccountId);
  const updatedAt = cleanText(record.updatedAt);
  if (!sessionId || !artifactId || !path || !name || !createdByAccountId || !updatedAt) return null;
  return {
    artifactActivityId: cleanText(record.artifactActivityId) || `cloud-artifact:${sessionId}:${artifactId}`,
    sessionId,
    artifactId,
    name,
    path,
    kind: cleanText(record.kind) || 'file',
    category: cleanText(record.category) || 'artifact',
    summary: nullableText(record.summary),
    createdByAccountId,
    sourceMessageId: nullableText(record.sourceMessageId),
    attachmentId: nullableText(record.attachmentId),
    contentType: nullableText(record.contentType),
    sizeBytes: finiteNumber(record.sizeBytes),
    createdAt: cleanText(record.createdAt) || updatedAt,
    updatedAt,
    archivedAt: nullableText(record.archivedAt),
  };
}

function sortTasks(tasks: CloudTaskActivity[]) {
  return [...tasks].sort((left, right) => (
    right.updatedAt.localeCompare(left.updatedAt)
    || left.taskId.localeCompare(right.taskId)
  ));
}

function sortArtifacts(artifacts: CloudArtifactActivity[]) {
  return [...artifacts].sort((left, right) => (
    right.updatedAt.localeCompare(left.updatedAt)
    || left.artifactId.localeCompare(right.artifactId)
  ));
}

export function normalizeCloudSessionActivitySnapshot(snapshot: CloudSessionActivity): CloudSessionActivityStore {
  const tasksBySessionId: Record<string, CloudTaskActivity[]> = {};
  const artifactsBySessionId: Record<string, CloudArtifactActivity[]> = {};
  for (const value of snapshot.tasks ?? []) {
    const task = normalizeTask(value);
    if (!task || task.archivedAt) continue;
    tasksBySessionId[task.sessionId] = [...(tasksBySessionId[task.sessionId] ?? []), task];
  }
  for (const value of snapshot.artifacts ?? []) {
    const artifact = normalizeArtifact(value);
    if (!artifact || artifact.archivedAt) continue;
    artifactsBySessionId[artifact.sessionId] = [...(artifactsBySessionId[artifact.sessionId] ?? []), artifact];
  }
  for (const [sessionId, tasks] of Object.entries(tasksBySessionId)) tasksBySessionId[sessionId] = sortTasks(tasks);
  for (const [sessionId, artifacts] of Object.entries(artifactsBySessionId)) artifactsBySessionId[sessionId] = sortArtifacts(artifacts);
  return { tasksBySessionId, artifactsBySessionId };
}

function newerOrEqual(left: { updatedAt: string }, right: { updatedAt: string }) {
  return left.updatedAt.localeCompare(right.updatedAt) >= 0;
}

export function mergeCloudSessionActivity(current: CloudSessionActivityStore, incoming: CloudSessionActivityStore): CloudSessionActivityStore {
  if (Object.is(current, incoming)) return current;
  const tasksBySessionId: Record<string, CloudTaskActivity[]> = { ...current.tasksBySessionId };
  for (const [sessionId, incomingTasks] of Object.entries(incoming.tasksBySessionId)) {
    const byTaskId = new Map((tasksBySessionId[sessionId] ?? []).map((task) => [task.taskId, task]));
    for (const task of incomingTasks) {
      const existing = byTaskId.get(task.taskId);
      if (!existing || newerOrEqual(task, existing)) byTaskId.set(task.taskId, task);
    }
    tasksBySessionId[sessionId] = sortTasks([...byTaskId.values()].filter((task) => !task.archivedAt));
  }

  const artifactsBySessionId: Record<string, CloudArtifactActivity[]> = { ...current.artifactsBySessionId };
  for (const [sessionId, incomingArtifacts] of Object.entries(incoming.artifactsBySessionId)) {
    const byArtifactId = new Map((artifactsBySessionId[sessionId] ?? []).map((artifact) => [artifact.artifactId, artifact]));
    for (const artifact of incomingArtifacts) {
      const existing = byArtifactId.get(artifact.artifactId);
      if (!existing || newerOrEqual(artifact, existing)) byArtifactId.set(artifact.artifactId, artifact);
    }
    artifactsBySessionId[sessionId] = sortArtifacts([...byArtifactId.values()].filter((artifact) => !artifact.archivedAt));
  }
  const merged = { tasksBySessionId, artifactsBySessionId };
  return cloudSessionActivityEqual(current, merged) ? current : merged;
}

function participantFromCloud(value: unknown, fallbackAccountId: string): SessionTaskParticipant | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const accountId = cleanText(record.accountId) || cleanText(record.id) || fallbackAccountId;
  const name = cleanText(record.displayName) || cleanText(record.name) || accountId;
  if (!accountId || !name) return null;
  return {
    id: `cloud:${accountId}`,
    name,
    kind: cleanText(record.kind) || 'human',
    role: cleanText(record.role) || 'person',
    avatarKey: cleanText(record.avatarKey) || accountId,
    profileImageUrl: nullableText(record.avatarUrl) ?? nullableText(record.profileImageUrl),
  };
}

function taskStatus(value: string): SessionTaskActivity['status'] {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'complete' || normalized === 'completed') return 'complete';
  if (normalized === 'closed') return 'closed';
  if (normalized === 'failed') return 'failed';
  if (normalized === 'cancelled') return 'cancelled';
  return normalized || 'active';
}

export function cloudTaskToSessionTaskActivity(task: CloudTaskActivity): SessionTaskActivity {
  const participants = task.participants
    .map((participant) => participantFromCloud(participant, task.createdByAccountId))
    .filter((participant): participant is SessionTaskParticipant => Boolean(participant));
  const initiator = participants.find((participant) => participant.id === `cloud:${task.createdByAccountId}`) ?? {
    id: `cloud:${task.createdByAccountId}`,
    name: task.createdByAccountId,
    kind: 'human',
    role: 'person',
    avatarKey: task.createdByAccountId,
  };
  return {
    id: `cloud-task:${task.sessionId}:${task.taskId}`,
    sessionId: task.sessionId,
    status: taskStatus(task.status),
    initiator,
    target: {
      id: `task:${task.taskId}`,
      name: task.title,
      kind: 'agent',
      role: 'external-agent',
      avatarKey: task.targetAccountId ?? task.createdByAccountId,
    },
    participants,
    createdAtMs: Date.parse(task.createdAt) || 0,
    updatedAtMs: Date.parse(task.updatedAt) || 0,
    sourceRequestId: task.taskId,
    contextPolicy: 'cloud-session-activity',
    error: null,
  };
}

function artifactKind(value: string): SessionArtifact['kind'] {
  return value === 'code' || value === 'document' ? value : 'file';
}

function artifactCategory(value: string): SessionArtifact['category'] {
  return value === 'related' || value === 'memory' ? value : 'artifact';
}

export function cloudArtifactToSessionArtifact(artifact: CloudArtifactActivity): SessionArtifact {
  const updatedAtMs = Date.parse(artifact.updatedAt);
  return {
    id: artifact.artifactId,
    path: artifact.path,
    name: artifact.name,
    kind: artifactKind(artifact.kind),
    category: artifactCategory(artifact.category),
    summary: artifact.summary ?? `Cloud artifact from ${artifact.createdByAccountId}`,
    ...(Number.isFinite(updatedAtMs) ? { timeLabel: formatDesktopLastActiveLabel(updatedAtMs) } : {}),
  };
}

export function cloudTaskActivitiesForSession(store: CloudSessionActivityStore, sessionId: string): SessionTaskActivity[] {
  const byId = new Map<string, SessionTaskActivity>();
  for (const task of store.tasksBySessionId[sessionId] ?? []) {
    const activity = cloudTaskToSessionTaskActivity(task);
    byId.set(activity.id, activity);
  }
  return [...byId.values()];
}

function taskOperatorStatusFromCloudStatus(status: string): string {
  const normalized = status.trim().toLowerCase();
  if (normalized === 'closed' || normalized === 'complete' || normalized === 'completed') return 'closed';
  if (normalized === 'failed' || normalized === 'cancelled') return normalized;
  return 'open';
}

function cloudTaskParticipantNames(task: CloudTaskActivity): string[] {
  return Array.from(new Set(task.participants
    .map((participant) => participantFromCloud(participant, task.createdByAccountId)?.name?.trim() ?? '')
    .filter(Boolean)));
}

export function cloudVisibleTaskRecordsForSession(store: CloudSessionActivityStore, sessionId: string): DesktopVisibleTaskRecord[] {
  return (store.tasksBySessionId[sessionId] ?? []).map((task) => ({
    taskId: task.taskId,
    parentTaskId: null,
    title: task.title,
    summary: task.summary,
    status: taskOperatorStatusFromCloudStatus(task.status),
    involvedParticipants: cloudTaskParticipantNames(task),
  }));
}

export function cloudArtifactsForSession(store: CloudSessionActivityStore, sessionId: string): SessionArtifact[] {
  const byId = new Map<string, SessionArtifact>();
  for (const artifact of store.artifactsBySessionId[sessionId] ?? []) {
    const item = cloudArtifactToSessionArtifact(artifact);
    byId.set(item.id, item);
  }
  return [...byId.values()];
}

export function loadCachedCloudSessionActivity(accountId: string | null | undefined, storage: Storage | null = browserLocalStorage()): CloudSessionActivityStore {
  const trimmedAccountId = accountId?.trim() ?? '';
  if (!trimmedAccountId || !storage) return EMPTY_CLOUD_SESSION_ACTIVITY;
  try {
    const parsed = JSON.parse(storage.getItem(cloudActivityStorageKey(trimmedAccountId)) ?? 'null');
    if (!parsed || typeof parsed !== 'object') return EMPTY_CLOUD_SESSION_ACTIVITY;
    return {
      tasksBySessionId: (parsed as CloudSessionActivityStore).tasksBySessionId ?? {},
      artifactsBySessionId: (parsed as CloudSessionActivityStore).artifactsBySessionId ?? {},
    };
  } catch {
    return EMPTY_CLOUD_SESSION_ACTIVITY;
  }
}

export function saveCachedCloudSessionActivity(accountId: string | null | undefined, store: CloudSessionActivityStore, storage: Storage | null = browserLocalStorage()): void {
  const trimmedAccountId = accountId?.trim() ?? '';
  if (!trimmedAccountId || !storage) return;
  try {
    storage.setItem(cloudActivityStorageKey(trimmedAccountId), JSON.stringify(store));
  } catch {
    // Best effort cache; cursor sync remains authoritative.
  }
}

function parseToolArgs(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'task';
}

function taskTitleFromArgs(args: Record<string, unknown>): string | null {
  return nullableText(args.taskTitle) ?? nullableText(args.task_title) ?? nullableText(args.title) ?? nullableText(args.task) ?? nullableText(args.name);
}

function taskTitleFromResultText(text?: string | null): string | null {
  const value = text?.trim() ?? '';
  if (!value) return null;
  const match = /(?:created|opened|updated|closed)\s+(?:the\s+)?(?:task|test task)\s*:?\s*\*\*([^*]+)\*\*/i.exec(value)
    ?? /(?:created|opened|updated|closed)\s+(?:the\s+)?(?:task|test task)\s*:?\s*([^\n.]+)/i.exec(value);
  return match?.[1]?.trim() || null;
}

function taskIdFromArgs(args: Record<string, unknown>, resultText?: string | null): string | null {
  const explicit = nullableText(args.taskId) ?? nullableText(args.task_id) ?? nullableText(args.id);
  if (explicit) return explicit;
  const result = resultText?.trim() ?? '';
  const match = /(?:^|[\n;])\s*(?:-\s*)?(?:Task ID|ID):\s*`([^`]+)`/i.exec(result);
  return match?.[1]?.trim() || null;
}

function cloudActivityParticipants(accountIds: string[], profiles: CloudActivityParticipantProfile[] = []) {
  const profileByAccountId = new Map(profiles
    .map((profile) => [profile.accountId.trim(), profile] as const)
    .filter(([accountId]) => Boolean(accountId)));
  return accountIds.map((accountId) => {
    const profile = profileByAccountId.get(accountId);
    return {
      accountId,
      displayName: profile?.displayName?.trim() || accountId,
      ...(profile?.avatarUrl?.trim() ? { avatarUrl: profile.avatarUrl.trim() } : {}),
      ...(profile?.role?.trim() ? { role: profile.role.trim() } : {}),
    };
  });
}

export function deriveCloudActivityFromTurn(input: {
  sessionId: string;
  localAccountId: string;
  participantAccountIds: string[];
  participantProfiles?: CloudActivityParticipantProfile[];
  turn: DesktopChatTurnSnapshot;
}): { tasks: PublishCloudTaskActivityInput[]; artifacts: PublishCloudArtifactActivityInput[] } {
  const clientUpdatedAt = new Date(input.turn.completedAtMs ?? Date.now()).toISOString();
  const participants = cloudActivityParticipants(input.participantAccountIds, input.participantProfiles);
  const tasks: PublishCloudTaskActivityInput[] = [];
  for (const tool of input.turn.tools) {
    if (tool.name.trim().toLowerCase() !== 'task_operator') continue;
    const args = parseToolArgs(tool.arguments) ?? {};
    if (tool.isError) continue;
    const title = taskTitleFromArgs(args) ?? taskTitleFromResultText(tool.resultText);
    const taskId = taskIdFromArgs(args, tool.resultText) ?? (title ? slugify(title) : null);
    const action = cleanText(args.action).toLowerCase();
    if (!title || !taskId || (action !== 'create' && action !== 'close')) continue;
    const status = action === 'close' ? 'closed' : 'active';
    tasks.push({
      sessionId: input.sessionId,
      taskId,
      title,
      summary: nullableText(args.summary) ?? (input.turn.assistantText || null),
      status,
      createdByAccountId: input.localAccountId,
      targetAccountId: input.localAccountId,
      participantAccountIds: input.participantAccountIds,
      participants,
      artifactIds: [],
      responseMessageId: input.turn.id,
      clientUpdatedAt,
    });
  }

  const artifacts = changedFileRowsFromTurn(input.turn).map((row): PublishCloudArtifactActivityInput => {
    const name = row.artifactId.split('/').filter(Boolean).pop() || row.artifactId;
    const extension = name.split('.').pop()?.toLowerCase() ?? '';
    const kind = ['md', 'markdown', 'txt', 'pdf', 'docx'].includes(extension) ? 'document' : ['ts', 'tsx', 'js', 'jsx', 'rs', 'py', 'go', 'css', 'html'].includes(extension) ? 'code' : 'file';
    return {
      sessionId: input.sessionId,
      artifactId: row.artifactId,
      name,
      path: row.path,
      kind,
      category: 'artifact',
      summary: `Changed ${row.status} file`,
      createdByAccountId: input.localAccountId,
      participantAccountIds: input.participantAccountIds,
      sourceMessageId: input.turn.id,
      attachmentId: null,
      contentType: null,
      sizeBytes: null,
      clientUpdatedAt,
    };
  });

  return { tasks, artifacts };
}

export function cloneCloudSessionActivityForFork(
  source: CloudSessionActivityStore,
  sourceSessionId: string,
  forkSessionId: string,
  updatedAt: string,
): CloudSessionActivityStore {
  return normalizeCloudSessionActivitySnapshot({
    tasks: (source.tasksBySessionId[sourceSessionId] ?? []).map((task) => ({
      ...task,
      taskActivityId: `fork:${forkSessionId}:${task.taskActivityId}`,
      sessionId: forkSessionId,
      updatedAt,
    })),
    artifacts: (source.artifactsBySessionId[sourceSessionId] ?? []).map((artifact) => ({
      ...artifact,
      artifactActivityId: `fork:${forkSessionId}:${artifact.artifactActivityId}`,
      sessionId: forkSessionId,
      updatedAt,
    })),
  });
}
