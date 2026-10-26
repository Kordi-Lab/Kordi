import { DEFAULT_LOCAL_AGENT_AVATAR_SEED } from '@/features/canonical/localAgentAvatar';
import { usesDefaultLocalAgentSession } from '@/features/chat/agentSessionRouting';
import { primaryAgentForConversation } from '@/features/chat/participantSpaces';
import type { Agent, Conversation } from '@/kordi-app/types';
import type { PersonalAgentSession } from './personalAgentClient';
import type { PersonalAgentEntry } from './personalAgentStore';

/** The server id of the owner's default agent. */
export function defaultPersonalAgentId(accountId: string) {
  return `cloud-agent:${accountId}`;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** The agent id a session's metadata marks it as the personal session of, if any. */
export function personalAgentMarker(metadata: unknown): string | null {
  const agentId = record(record(metadata).personalAgent).agentId;
  return typeof agentId === 'string' && agentId.trim() ? agentId.trim() : null;
}

/** Joins the server's personal sessions with the local agent list for names and avatars. */
export function joinPersonalAgents(
  sessions: readonly PersonalAgentSession[],
  agents: readonly Agent[],
  accountId: string,
): PersonalAgentEntry[] {
  const defaultId = defaultPersonalAgentId(accountId);
  return sessions.flatMap((session): PersonalAgentEntry[] => {
    if (session.agentId === defaultId) {
      const agent = agents.find(usesDefaultLocalAgentSession);
      return [{
        ...session,
        name: agent?.name.trim() || 'Kordi',
        localAgentId: agent?.id ?? 'desktop:local-agent',
        avatarSeed: DEFAULT_LOCAL_AGENT_AVATAR_SEED,
        profileImageUrl: agent?.profileImageUrl ?? null,
        isDefault: true,
      }];
    }
    // A Factory agent the local list does not hold yet keeps its row; the
    // session supplies its name until the agent loads.
    const agent = agents.find((candidate) => candidate.cloudAgentId === session.agentId);
    return [{
      ...session,
      name: agent?.name.trim() || 'Agent',
      localAgentId: agent?.id ?? null,
      avatarSeed: agent?.avatarSeed?.trim() || agent?.id || session.agentId,
      profileImageUrl: agent?.profileImageUrl ?? null,
      isDefault: false,
    }];
  });
}

type ConversationIds = Pick<Conversation, 'id' | 'metadata'> & { canonicalSessionId?: string | null };
type ConversationLike = ConversationIds & Partial<Pick<Conversation, 'canonicalParticipants' | 'participants' | 'name' | 'type'>>;

/** The agent a personal session's conversation names, for an agent the local list does not hold. */
function withConversationAgent(entry: PersonalAgentEntry, conversation: ConversationLike): PersonalAgentEntry {
  if (entry.localAgentId || !conversation.canonicalParticipants?.length) return entry;
  const agent = primaryAgentForConversation(conversation as Conversation);
  return agent ? { ...entry, name: agent.name || entry.name, avatarSeed: agent.avatarSeed || entry.avatarSeed, profileImageUrl: agent.profileImageUrl ?? entry.profileImageUrl } : entry;
}

/**
 * The personal agent a conversation belongs to: by session id, then by the
 * session's marker. A marked session the list does not name yet (it has not
 * loaded) still counts, as the marked agent.
 */
export function personalAgentEntryForConversation(
  entries: readonly PersonalAgentEntry[],
  conversation: ConversationLike | null | undefined,
): PersonalAgentEntry | null {
  if (!conversation) return null;
  const ids = new Set([conversation.id, conversation.canonicalSessionId].map((id) => id?.trim()).filter(Boolean));
  const marker = personalAgentMarker(conversation.metadata);
  const entry = entries.find((candidate) => ids.has(candidate.sessionId) || (candidate.conversationId && ids.has(candidate.conversationId)))
    ?? (marker ? entries.find((candidate) => candidate.agentId === marker) : undefined);
  if (entry) return withConversationAgent(entry, conversation);
  if (!marker) return null;
  return withConversationAgent({
    agentId: marker, conversationId: '', sessionId: conversation.canonicalSessionId?.trim() || conversation.id, proactive: false,
    name: 'Agent', localAgentId: null, avatarSeed: marker, profileImageUrl: null, isDefault: false,
  }, conversation);
}
