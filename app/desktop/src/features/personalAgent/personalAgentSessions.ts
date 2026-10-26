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

/**
 * The local sessions this Mac still needs for the owner's personal agents.
 * Each uses the server's session id, so the cloud mirror files the agent's
 * messages there, and is set up like a chat started with that agent, so
 * replies come from it and sends target it. A session that already carries
 * the marker for its agent is left as it is.
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
    if (existing && personalAgentMarker(existing.metadata) === entry.agentId) return [];
    const marker = { personalAgent: { agentId: entry.agentId } };
    if (entry.isDefault) {
      const primaryIdentityId = ownedAgentIdentityId(state, existing?.primaryIdentityId ?? state.profile.activeAgentIdentityId);
      if (!primaryIdentityId) return [];
      return [{
        session: {
          id: entry.sessionId, kind: 'self-agent', title: existing?.title || entry.name, status: 'active',
          createdByIdentityId: humanIdentityId, primaryIdentityId, participantIdentityIds: [primaryIdentityId],
          metadata: { ...record(existing?.metadata), cloudSelfAgentSession: true, ...marker },
        },
      }];
    }
    const agent = agents.find((candidate) => candidate.id === entry.localAgentId);
    const identity = agent ? agentCanonicalIdentityRequest(agent) : null;
    const identityId = identity?.id?.trim();
    if (!agent || !identity || !identityId) return [];
    return [{
      identity,
      session: {
        id: entry.sessionId, kind: 'direct-agent', title: existing?.title || agent.name, status: 'active',
        createdByIdentityId: humanIdentityId, primaryIdentityId: identityId, relationshipIdentityId: null,
        participantIdentityIds: [identityId],
        metadata: { ...record(existing?.metadata), ...buildChatAgentSessionMetadata(agent), ...marker },
      },
    }];
  });
}
