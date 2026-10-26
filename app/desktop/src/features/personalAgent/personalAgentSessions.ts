import { agentCanonicalIdentityRequest, buildChatAgentSessionMetadata } from '@/features/chat/chatCreateFlows';
import { ownedAgentIdentityId } from '@/features/chat/messageActions/agentMessageLifecycle';
import type {
  Agent,
  CanonicalSessionState,
  OpenCanonicalSessionRequest,
  UpsertCanonicalIdentityRequest,
} from '@/kordi-app/types';
import { personalAgentMarker } from './personalAgentEntries';
import type { PersonalAgentEntry } from './personalAgentStore';

export type PersonalAgentSessionPlan = {
  identity?: UpsertCanonicalIdentityRequest;
  session: OpenCanonicalSessionRequest;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** The identities that stand for the owner's default agent in its personal session. */
function defaultAgentIdentityIds(state: CanonicalSessionState, agentId: string) {
  const ids = new Set<string>();
  const local = ownedAgentIdentityId(state, state.profile.activeAgentIdentityId);
  if (local) ids.add(local);
  // The cloud mirror files the default agent's replies under this identity.
  if (agentId.startsWith('cloud-agent:')) ids.add(`agent:cloud-self:${agentId.slice('cloud-agent:'.length)}`);
  return { ids, preferred: local };
}

/**
 * The local sessions this Mac still needs for the owner's personal agents.
 * Each uses the server's session id, so the cloud mirror files the agent's
 * messages there, and is set up like a chat started with that agent, so
 * replies come from it and sends target it. A session that has its marker,
 * kind, agent identity and target is left as it is; anything else (a missing
 * session, or one rewritten for another agent) is repaired.
 */
export function planPersonalAgentSessions(
  entries: readonly PersonalAgentEntry[],
  agents: readonly Agent[],
  state: CanonicalSessionState | null,
): PersonalAgentSessionPlan[] {
  const humanIdentityId = state?.profile.humanIdentityId?.trim();
  if (!state || !humanIdentityId) return [];
  return entries.flatMap((entry): PersonalAgentSessionPlan[] => {
    const existing = state.sessions.find((session) => session.id === entry.sessionId);
    const metadata = record(existing?.metadata);
    const marked = personalAgentMarker(existing?.metadata) === entry.agentId;
    const marker = { personalAgent: { agentId: entry.agentId } };
    if (entry.isDefault) {
      const own = defaultAgentIdentityIds(state, entry.agentId);
      const existingPrimary = existing?.primaryIdentityId?.trim() ?? '';
      if (existing && marked && existing.kind === 'self-agent' && own.ids.has(existingPrimary) && !metadata.cloudAgentId) return [];
      const primaryIdentityId = own.ids.has(existingPrimary) ? existingPrimary : own.preferred;
      if (!primaryIdentityId) return [];
      // Another agent's target, left by an earlier rewrite, would send the owner's messages there.
      const { cloudAgentId: _agentId, cloudAgentName: _agentName, cloudSelfAgentTarget: _target, ...rest } = metadata;
      return [{
        session: {
          id: entry.sessionId, kind: 'self-agent', title: existing?.title || entry.name, status: 'active',
          createdByIdentityId: humanIdentityId, primaryIdentityId, participantIdentityIds: [primaryIdentityId],
          metadata: { ...rest, cloudSelfAgentSession: true, ...marker },
        },
      }];
    }
    const agent = entry.localAgentId ? agents.find((candidate) => candidate.id === entry.localAgentId) : undefined;
    const identity = agent ? agentCanonicalIdentityRequest(agent) : null;
    const identityId = identity?.id?.trim();
    if (!agent || !identity || !identityId) return [];
    if (existing && marked && existing.kind === 'direct-agent' && existing.primaryIdentityId === identityId
      && metadata.cloudAgentId === agent.cloudAgentId) return [];
    return [{
      identity,
      session: {
        id: entry.sessionId, kind: 'direct-agent', title: existing?.title || agent.name, status: 'active',
        createdByIdentityId: humanIdentityId, primaryIdentityId: identityId, relationshipIdentityId: null,
        participantIdentityIds: [identityId],
        metadata: { ...metadata, ...buildChatAgentSessionMetadata(agent), ...marker },
      },
    }];
  });
}

/**
 * Sessions that carry a personal marker their agent no longer has: the agent
 * left the loaded list (Proactive was turned off), or, before the list
 * loads, the session's own cached snapshot has no `personal_agent`. Each goes
 * back to an ordinary agent chat; nothing is stripped without a loaded source.
 */
export function planPersonalAgentMarkerRemovals(
  state: CanonicalSessionState | null,
  source: { listedSessionIds: ReadonlySet<string> | null; markerlessSnapshotSessionIds: ReadonlySet<string> },
): PersonalAgentSessionPlan[] {
  if (!state) return [];
  return state.sessions.flatMap((session): PersonalAgentSessionPlan[] => {
    if (!personalAgentMarker(session.metadata)) return [];
    const dropped = source.listedSessionIds
      ? !source.listedSessionIds.has(session.id)
      : source.markerlessSnapshotSessionIds.has(session.id);
    if (!dropped || !session.createdByIdentityId) return [];
    const primaryIdentityId = session.primaryIdentityId?.trim() || null;
    return [{
      session: {
        id: session.id, kind: session.kind as PersonalAgentSessionPlan['session']['kind'], title: session.title, status: session.status,
        createdByIdentityId: session.createdByIdentityId, primaryIdentityId,
        projectId: session.projectId ?? null, projectName: session.projectName ?? null,
        relationshipIdentityId: session.relationshipIdentityId ?? null,
        participantIdentityIds: primaryIdentityId ? [primaryIdentityId] : [],
        // An explicit null: the native upsert keeps a key that is left out.
        metadata: { ...record(session.metadata), personalAgent: null },
      },
    }];
  });
}
