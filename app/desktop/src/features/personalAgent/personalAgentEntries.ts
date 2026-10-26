import { DEFAULT_LOCAL_AGENT_AVATAR_SEED } from '@/features/canonical/localAgentAvatar';
import { usesDefaultLocalAgentSession } from '@/features/chat/agentSessionRouting';
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

/**
 * Joins the server's personal sessions with the local agent list for names and
 * avatars. A Factory agent the list does not hold yet is left out until it does.
 */
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
    const agent = agents.find((candidate) => candidate.cloudAgentId === session.agentId);
    if (!agent) return [];
    return [{
      ...session,
      name: agent.name.trim() || 'Agent',
      localAgentId: agent.id,
      avatarSeed: agent.avatarSeed?.trim() || agent.id,
      profileImageUrl: agent.profileImageUrl ?? null,
      isDefault: false,
    }];
  });
}

type ConversationIds = Pick<Conversation, 'id' | 'metadata'> & { canonicalSessionId?: string | null };

/** The personal agent a conversation belongs to: by session id, then by the session's marker. */
export function personalAgentEntryForConversation(
  entries: readonly PersonalAgentEntry[],
  conversation: ConversationIds | null | undefined,
): PersonalAgentEntry | null {
  if (!conversation || entries.length === 0) return null;
  const ids = new Set([conversation.id, conversation.canonicalSessionId].map((id) => id?.trim()).filter(Boolean));
  const marker = personalAgentMarker(conversation.metadata);
  return entries.find((entry) => ids.has(entry.sessionId) || (entry.conversationId && ids.has(entry.conversationId)))
    ?? (marker ? entries.find((entry) => entry.agentId === marker) ?? null : null);
}

/** Whether a conversation is an agent's personal session, even before the list loads. */
export function isPersonalAgentConversation(entries: readonly PersonalAgentEntry[], conversation: ConversationIds) {
  return Boolean(personalAgentMarker(conversation.metadata) || personalAgentEntryForConversation(entries, conversation));
}
