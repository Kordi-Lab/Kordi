import type {
  CanonicalSessionState,
  Conversation,
  DesktopChatProjectGroup,
} from '@/kordi-app/types';

const CANONICAL_BRIDGE_SESSION_PREFIX = 'session:bridge:';

export type CanonicalConversationLookupTarget = {
  humanId?: string | null;
  agentId?: string | null;
  bridgeNodeId?: string | null;
};

export type ProjectRoutingGroup = {
  id: string;
  sessions: Array<{ id: string }>;
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

    let rank = Number.POSITIVE_INFINITY;
    if (normalizedAgentId && participants.some((participant) => participant.agentId === normalizedAgentId)) {
      rank = conversation.directness === 'Direct chat' ? 0 : 1;
    } else if (normalizedHumanId && participants.some((participant) => participant.humanId === normalizedHumanId)) {
      rank = conversation.directness === 'Direct chat' ? 0 : 1;
    } else if (normalizedBridgeNodeId && participants.some((participant) => participant.bridgeNodeId === normalizedBridgeNodeId)) {
      rank = conversation.directness === 'Direct chat' ? 2 : 3;
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

  const addGroup = (groupId: string, timestampMs: number) => {
    if (!sessionIdsByGroupId.has(groupId)) {
      sessionIdsByGroupId.set(groupId, []);
      groupIdsInOrder.push(groupId);
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
    for (const session of project.sessions) {
      addSession(groupId, session.id, 0);
    }
  }

  for (const session of canonicalState?.sessions ?? []) {
    if (session.kind !== 'project') continue;
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
      sessions: (sessionIdsByGroupId.get(groupId) ?? [])
        .sort((left, right) => (sessionTimestampById.get(right) ?? 0) - (sessionTimestampById.get(left) ?? 0))
        .map((id) => ({ id })),
    }))
    .filter((group) => group.sessions.length > 0);
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

  return resolvedSessionId
    ? {
        projectId: resolvedProject.id,
        sessionId: resolvedSessionId,
      }
    : null;
}
