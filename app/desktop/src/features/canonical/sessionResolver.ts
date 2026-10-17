import type {
  CanonicalSessionState,
  Conversation,
  DesktopChatProjectGroup,
} from '@/kordi-app/types';
import { canonicalMessageCountsAsReadable } from './readModel/messageVisibility';

const LEGACY_CANONICAL_COLLABORATION_SESSION_PREFIX = 'session:bridge:';
const CANONICAL_CLOUD_DIRECT_PERSON_SESSION_PREFIX = 'session:direct-person:';
const CANONICAL_CLOUD_GROUP_SESSION_PREFIX = 'session:group:';

export type CanonicalConversationLookupTarget = {
  humanId?: string | null;
  agentId?: string | null;
  sourceIdentityId?: string | null;
};

export type ProjectRoutingGroup = {
  id: string;
  sessions: Array<{ id: string }>;
  persisted?: boolean;
  /** Display name another Mac published for a project this Mac does not have. */
  name?: string;
  /** The project folder is on another Mac; it cannot start sessions or read Git here. */
  remote?: boolean;
};

/** A project another Mac on the account publishes, with the session IDs it groups. */
export type RemoteProjectMembership = {
  id: string;
  name: string;
  sessions: readonly string[];
  /** Root of the local project with the same catalog ID, when this Mac has it too. */
  localRoot?: string | null;
  /** Session ID to the catalog ID of the worktree it runs in. */
  workspaces?: Readonly<Record<string, string>>;
};

export const REMOTE_PROJECT_GROUP_PREFIX = 'remote-project:';

/** The catalog ID of a project group whose folder this Mac has not found. */
export function remoteProjectCatalogId(groupId?: string | null) {
  return groupId?.startsWith(REMOTE_PROJECT_GROUP_PREFIX) ? groupId.slice(REMOTE_PROJECT_GROUP_PREFIX.length) : null;
}

/** A local session the project catalog may not list yet, with any workspace paths it already carries. */
export type ProjectSessionHint = {
  sessionId: string;
  /** Working directories of the session; a path at or under a known project root binds it there. */
  paths?: ReadonlyArray<string | null | undefined>;
  updatedAtMs?: number | null;
  /** False when fresh runtime detail shows the session left its project. */
  rememberMembership?: boolean;
};

export type ProjectRoutingOptions = {
  sessionHints?: readonly ProjectSessionHint[];
  /** Sessions the runtime lists as plain chats; they never inherit a project from a hint or memory. */
  unboundSessionIds?: ReadonlySet<string>;
  /** Project group each session was last shown under. */
  previousGroupIdBySession?: ReadonlyMap<string, string>;
  /** Other Macs' catalogs; they place synced sessions this Mac has no project for. */
  remoteProjects?: readonly RemoteProjectMembership[];
};

function normalizedProjectRoot(value?: string | null) {
  const trimmed = (value ?? '').trim();
  return trimmed || null;
}

function projectMetadata(session: CanonicalSessionState['sessions'][number]) {
  return session.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
    ? session.metadata as Record<string, unknown>
    : {};
}

function projectRootFromMetadata(session: CanonicalSessionState['sessions'][number]) {
  const metadata = projectMetadata(session);
  const projectRoot = metadata.projectRoot;
  return typeof projectRoot === 'string' ? normalizedProjectRoot(projectRoot) : null;
}

export function canonicalProjectGroupIdFromRoot(projectRoot?: string | null) {
  const normalizedRoot = normalizedProjectRoot(projectRoot);
  return normalizedRoot ? `project:${normalizedRoot}` : null;
}

export function normalizeCanonicalProjectGroupId(projectId?: string | null, projectRoot?: string | null) {
  const normalizedProjectId = (projectId ?? '').trim();
  if (normalizedProjectId.startsWith('project:')) {
    return normalizedProjectId;
  }
  return canonicalProjectGroupIdFromRoot(normalizedProjectId || projectRoot);
}

export function projectRootFromCanonicalProjectGroupId(projectId?: string | null) {
  const normalizedProjectId = (projectId ?? '').trim();
  if (!normalizedProjectId) return null;
  return normalizedProjectId.startsWith('project:')
    ? normalizedProjectRoot(normalizedProjectId.slice('project:'.length))
    : normalizedProjectRoot(normalizedProjectId);
}

function trimTrailingSeparators(path: string) {
  return path.length > 1 ? path.replace(/[\\/]+$/u, '') : path;
}

function pathIsWithinRoot(path: string, root: string) {
  const normalizedPath = trimTrailingSeparators(path);
  const normalizedRoot = trimTrailingSeparators(root);
  if (!normalizedRoot) return false;
  return normalizedPath === normalizedRoot
    || normalizedPath.startsWith(`${normalizedRoot}/`)
    || normalizedPath.startsWith(`${normalizedRoot}\\`);
}

function isLegacyStableHumanCollaborationSessionId(value?: string | null) {
  return (value ?? '').trim().startsWith('session:bridge:humans:');
}

export function findCanonicalConversationForTarget(
  conversations: Conversation[],
  target: CanonicalConversationLookupTarget,
): Conversation | null {
  const normalizedHumanId = target.humanId?.trim();
  const normalizedAgentId = target.agentId?.trim();
  const normalizedLegacyNodeId = target.sourceIdentityId?.trim();

  let bestMatch: { rank: number; conversation: Conversation } | null = null;
  for (const conversation of conversations) {
    const participants = conversation.canonicalParticipants ?? [];
    if (participants.length === 0) continue;

    const sessionId = conversation.canonicalSessionId ?? conversation.id;
    const stableHumanDirectSession = isLegacyStableHumanCollaborationSessionId(sessionId);
    const humanMatch = Boolean(normalizedHumanId && participants.some((participant) => participant.humanId === normalizedHumanId));
    const agentMatch = Boolean(normalizedAgentId && participants.some((participant) => participant.agentId === normalizedAgentId));
    const nodeMatch = Boolean(normalizedLegacyNodeId && participants.some((participant) => participant.sourceIdentityId === normalizedLegacyNodeId));

    let rank = Number.POSITIVE_INFINITY;

    // Contact entry points are direct-person intents. If a stable A<->B human
    // session already exists, prefer it over newer relationship/group sessions
    // that merely include the same human because they were invited into context.
    if (normalizedHumanId && humanMatch) {
      rank = stableHumanDirectSession ? 0 : conversation.type === 'person' ? 2 : 4;
    } else if (normalizedAgentId && agentMatch) {
      rank = !stableHumanDirectSession && conversation.type === 'external-agent' ? 0 : 3;
    } else if (normalizedLegacyNodeId && nodeMatch) {
      rank = stableHumanDirectSession ? 1 : conversation.type === 'person' ? 5 : 6;
    }

    if (!Number.isFinite(rank)) continue;
    if (!bestMatch || rank < bestMatch.rank) {
      bestMatch = { rank, conversation };
    }
  }

  return bestMatch?.conversation ?? null;
}

export function isLegacyCanonicalCollaborationSessionId(value?: string | null) {
  return (value ?? '').trim().startsWith(LEGACY_CANONICAL_COLLABORATION_SESSION_PREFIX);
}

export function isCanonicalCloudSessionId(value?: string | null) {
  const normalized = (value ?? '').trim();
  return normalized.startsWith(CANONICAL_CLOUD_DIRECT_PERSON_SESSION_PREFIX)
    || normalized.startsWith(CANONICAL_CLOUD_GROUP_SESSION_PREFIX);
}

export function findOwnedAgentConversation(conversations: Conversation[]) {
  return conversations.find(
    (conversation) => conversation.type === 'owned-agent' && !conversation.id.startsWith('bridge:'),
  ) ?? null;
}

export function buildProjectRoutingGroups(
  desktopProjects: DesktopChatProjectGroup[] | null | undefined,
  canonicalState: CanonicalSessionState | null | undefined,
  options: ProjectRoutingOptions = {},
): ProjectRoutingGroup[] {
  const groupIdsInOrder: string[] = [];
  const sessionIdsByGroupId = new Map<string, string[]>();
  const latestTimestampByGroupId = new Map<string, number>();
  const sessionTimestampById = new Map<string, number>();
  const persistedGroupIds = new Set<string>();
  const archivedSessionIds = new Set(
    (canonicalState?.sessions ?? [])
      .filter((session) => session.status === 'archived')
      .map((session) => session.id),
  );
  const messageCountBySessionId = new Map<string, number>();
  for (const message of canonicalState?.messages ?? []) {
    if (!canonicalMessageCountsAsReadable(message)) continue;
    messageCountBySessionId.set(message.sessionId, (messageCountBySessionId.get(message.sessionId) ?? 0) + 1);
  }

  const addGroup = (groupId: string, timestampMs: number, persisted = false) => {
    if (!sessionIdsByGroupId.has(groupId)) {
      sessionIdsByGroupId.set(groupId, []);
      groupIdsInOrder.push(groupId);
    }
    if (persisted) {
      persistedGroupIds.add(groupId);
    }
    latestTimestampByGroupId.set(groupId, Math.max(latestTimestampByGroupId.get(groupId) ?? 0, timestampMs));
  };

  const addSession = (groupId: string, sessionId: string, timestampMs: number) => {
    addGroup(groupId, timestampMs);
    sessionTimestampById.set(sessionId, Math.max(sessionTimestampById.get(sessionId) ?? 0, timestampMs));
    const currentSessionIds = sessionIdsByGroupId.get(groupId) ?? [];
    if (!currentSessionIds.includes(sessionId)) {
      currentSessionIds.push(sessionId);
      sessionIdsByGroupId.set(groupId, currentSessionIds);
    }
  };

  for (const project of desktopProjects ?? []) {
    const groupId = normalizeCanonicalProjectGroupId(project.id, project.root) ?? project.id;
    if (!groupId) continue;
    addGroup(groupId, 0, true);
    for (const session of project.sessions) {
      if (archivedSessionIds.has(session.id)) continue;
      addSession(groupId, session.id, 0);
    }
  }

  for (const session of canonicalState?.sessions ?? []) {
    if (session.kind !== 'project' || session.status === 'archived') continue;
    const title = session.title.trim().toLowerCase();
    const isBlankPlaceholder = (messageCountBySessionId.get(session.id) ?? 0) === 0
      && (!title || title === 'new session' || title === 'session');
    if (isBlankPlaceholder) continue;
    const groupId = normalizeCanonicalProjectGroupId(
      session.projectId,
      projectRootFromMetadata(session),
    );
    if (!groupId) continue;
    addSession(groupId, session.id, session.lastMessageAtMs ?? session.updatedAtMs ?? session.createdAtMs);
  }

  // The catalog can lag behind a session that already knows its project (a new
  // project chat, a send, a refresh). Place it from its own binding or from the
  // group it was last shown under so it never falls back to Recents.
  const placedSessionIds = new Set([...sessionIdsByGroupId.values()].flat());
  const groupRoots = groupIdsInOrder
    .map((groupId) => ({ groupId, root: projectRootFromCanonicalProjectGroupId(groupId) }))
    .filter((entry): entry is { groupId: string; root: string } => Boolean(entry.root))
    .sort((left, right) => right.root.length - left.root.length);
  for (const hint of options.sessionHints ?? []) {
    const sessionId = hint.sessionId;
    if (!sessionId || placedSessionIds.has(sessionId) || archivedSessionIds.has(sessionId)) continue;
    if (options.unboundSessionIds?.has(sessionId)) continue;
    const paths = (hint.paths ?? []).map(normalizedProjectRoot).filter((path): path is string => Boolean(path));
    const rememberedGroupId = hint.rememberMembership === false
      ? undefined
      : options.previousGroupIdBySession?.get(sessionId);
    const groupId = groupRoots.find((entry) => paths.some((path) => pathIsWithinRoot(path, entry.root)))?.groupId
      ?? (rememberedGroupId && sessionIdsByGroupId.has(rememberedGroupId) ? rememberedGroupId : undefined);
    if (!groupId) continue;
    addSession(groupId, sessionId, hint.updatedAtMs ?? 0);
    placedSessionIds.add(sessionId);
  }

  // Projects live on the Mac that created them. A new Mac or app profile only
  // receives the sessions, so group them as the publishing Mac does. These groups
  // are display-only: they never register or restore a local project.
  const knownSessionTimestamps = new Map<string, number>();
  for (const session of canonicalState?.sessions ?? []) {
    if (session.status === 'archived') continue;
    knownSessionTimestamps.set(session.id, session.lastMessageAtMs ?? session.updatedAtMs ?? session.createdAtMs);
  }
  for (const hint of options.sessionHints ?? []) {
    if (!knownSessionTimestamps.has(hint.sessionId)) knownSessionTimestamps.set(hint.sessionId, hint.updatedAtMs ?? 0);
  }
  const remoteNameByGroupId = new Map<string, string>();
  for (const project of options.remoteProjects ?? []) {
    const localGroupId = canonicalProjectGroupIdFromRoot(project.localRoot);
    const groupId = localGroupId ?? `${REMOTE_PROJECT_GROUP_PREFIX}${project.id}`;
    for (const sessionId of project.sessions) {
      if (placedSessionIds.has(sessionId) || archivedSessionIds.has(sessionId)) continue;
      if (options.unboundSessionIds?.has(sessionId) || !knownSessionTimestamps.has(sessionId)) continue;
      addSession(groupId, sessionId, knownSessionTimestamps.get(sessionId) ?? 0);
      placedSessionIds.add(sessionId);
    }
    if (!localGroupId && sessionIdsByGroupId.has(groupId)) remoteNameByGroupId.set(groupId, project.name);
  }

  return groupIdsInOrder
    .sort((left, right) => (latestTimestampByGroupId.get(right) ?? 0) - (latestTimestampByGroupId.get(left) ?? 0))
    .map((groupId) => ({
      id: groupId,
      persisted: persistedGroupIds.has(groupId),
      ...(remoteNameByGroupId.has(groupId) ? { name: remoteNameByGroupId.get(groupId), remote: true } : {}),
      sessions: (sessionIdsByGroupId.get(groupId) ?? [])
        .sort((left, right) => (sessionTimestampById.get(right) ?? 0) - (sessionTimestampById.get(left) ?? 0))
        .map((id) => ({ id })),
    }))
    .filter((group) => group.persisted || group.sessions.length > 0);
}

/** Remember where each session was shown; plain chats the runtime lists drop their memory. */
export function rememberProjectMembership(
  previous: ReadonlyMap<string, string>,
  groups: readonly ProjectRoutingGroup[],
  unboundSessionIds: ReadonlySet<string> = new Set(),
) {
  const next = new Map([...previous].filter(([sessionId]) => !unboundSessionIds.has(sessionId)));
  for (const group of groups) {
    for (const session of group.sessions) next.set(session.id, group.id);
  }
  return next;
}

export function resolveProjectSelection(
  projectGroups: ProjectRoutingGroup[],
  preferredProjectId: string,
  preferredSessionId: string,
  rememberedSessionIds: Record<string, string>,
) {
  if (projectGroups.length === 0) return null;

  const groupById = new Map(projectGroups.map((group) => [group.id, group]));
  const groupWithPreferredSession = projectGroups.find((group) => group.sessions.some((session) => session.id === preferredSessionId));
  const normalizedPreferredProjectId = normalizeCanonicalProjectGroupId(preferredProjectId, preferredProjectId) ?? preferredProjectId;
  const resolvedProject = groupWithPreferredSession
    ?? groupById.get(preferredProjectId)
    ?? groupById.get(normalizedPreferredProjectId)
    ?? projectGroups[0];

  const rememberedSessionId = rememberedSessionIds[resolvedProject.id];
  const resolvedSessionId = groupWithPreferredSession?.id === resolvedProject.id && preferredSessionId
    ? preferredSessionId
    : resolvedProject.sessions.find((session) => session.id === preferredSessionId)?.id
      ?? resolvedProject.sessions.find((session) => session.id === rememberedSessionId)?.id
      ?? resolvedProject.sessions[0]?.id;

  return {
    projectId: resolvedProject.id,
    sessionId: resolvedSessionId ?? '',
  };
}
