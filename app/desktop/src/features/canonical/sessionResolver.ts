import type {
  CanonicalSessionState,
  Conversation,
  DesktopChatProjectGroup,
} from '@/kordi-app/types';

const CANONICAL_BRIDGE_SESSION_PREFIX = 'session:bridge:';
const CANONICAL_CLOUD_DIRECT_PERSON_SESSION_PREFIX = 'session:direct-person:';
const CANONICAL_CLOUD_GROUP_SESSION_PREFIX = 'session:group:';

export type CanonicalConversationLookupTarget = {
  humanId?: string | null;
  agentId?: string | null;
  bridgeNodeId?: string | null;
};

export type ProjectRoutingGroup = {
  id: string;
  sessions: Array<{ id: string }>;
  persisted?: boolean;
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

function isStableHumanBridgeSessionId(value?: string | null) {
  return (value ?? '').trim().startsWith('session:bridge:humans:');
}

export function findCanonicalConversationForTarget(
  conversations: Conversation[],
  target: CanonicalConversationLookupTarget,
): Conversation | null {
  const normalizedHumanId = target.humanId?.trim();
  const normalizedAgentId = target.agentId?.trim();
  const normalizedBridgeNodeId = target.bridgeNodeId?.trim();

  let bestMatch: { rank: number; conversation: Conversation } | null = null;
  for (const conversation of conversations) {
    const participants = conversation.canonicalParticipants ?? [];
    if (participants.length === 0) continue;

    const sessionId = conversation.canonicalSessionId ?? conversation.id;
    const stableHumanDirectSession = isStableHumanBridgeSessionId(sessionId);
    const humanMatch = Boolean(normalizedHumanId && participants.some((participant) => participant.humanId === normalizedHumanId));
    const agentMatch = Boolean(normalizedAgentId && participants.some((participant) => participant.agentId === normalizedAgentId));
    const nodeMatch = Boolean(normalizedBridgeNodeId && participants.some((participant) => participant.bridgeNodeId === normalizedBridgeNodeId));

    let rank = Number.POSITIVE_INFINITY;

    // Contact entry points are direct-person intents. If a stable A<->B human
    // session already exists, prefer it over newer relationship/group sessions
    // that merely include the same human because they were invited into context.
    if (normalizedHumanId && humanMatch) {
      rank = stableHumanDirectSession ? 0 : conversation.type === 'person' ? 2 : 4;
    } else if (normalizedAgentId && agentMatch) {
      rank = !stableHumanDirectSession && conversation.type === 'external-agent' ? 0 : 3;
    } else if (normalizedBridgeNodeId && nodeMatch) {
      rank = stableHumanDirectSession ? 1 : conversation.type === 'person' ? 5 : 6;
    }

    if (!Number.isFinite(rank)) continue;
    if (!bestMatch || rank < bestMatch.rank) {
      bestMatch = { rank, conversation };
    }
  }

  return bestMatch?.conversation ?? null;
}

export function isCanonicalBridgeSessionId(value?: string | null) {
  return (value ?? '').trim().startsWith(CANONICAL_BRIDGE_SESSION_PREFIX);
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

  return groupIdsInOrder
    .sort((left, right) => (latestTimestampByGroupId.get(right) ?? 0) - (latestTimestampByGroupId.get(left) ?? 0))
    .map((groupId) => ({
      id: groupId,
      persisted: persistedGroupIds.has(groupId),
      sessions: (sessionIdsByGroupId.get(groupId) ?? [])
        .sort((left, right) => (sessionTimestampById.get(right) ?? 0) - (sessionTimestampById.get(left) ?? 0))
        .map((id) => ({ id })),
    }))
    .filter((group) => group.persisted || group.sessions.length > 0);
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
