import { defaultCloudAuthClient } from '@/features/cloud/authClient';
import type { ChatSyncConversation } from '@/features/cloud/chatSyncTypes';

/** One owned agent's always-online personal session, as `GET /v1/cloud/personal-agents` lists it. */
export type PersonalAgentSession = {
  /** `cloud-agent:<accountId>` for the default agent, the definition id for a Factory agent. */
  agentId: string;
  conversationId: string;
  sessionId: string;
  /** Whether the agent may message its owner first in this session. */
  proactive: boolean;
};

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Keeps entries with an agent and a session, in server order, one per agent. */
export function normalizePersonalAgentSessions(body: unknown): PersonalAgentSession[] {
  const agents = body && typeof body === 'object' ? (body as { agents?: unknown }).agents : null;
  if (!Array.isArray(agents)) return [];
  const seen = new Set<string>();
  return agents.flatMap((entry) => {
    const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
    const agentId = text(record.agentId);
    const sessionId = text(record.sessionId);
    if (!agentId || !sessionId || seen.has(agentId)) return [];
    seen.add(agentId);
    return [{ agentId, conversationId: text(record.conversationId), sessionId, proactive: record.proactive === true }];
  });
}

/**
 * The personal sessions named by cached chat-sync snapshots (`personal_agent`,
 * present only while the agent's Proactive is on), used until the list loads.
 */
export function personalAgentSessionsFromSnapshots(conversations: readonly ChatSyncConversation[]): PersonalAgentSession[] {
  const seen = new Set<string>();
  return conversations.flatMap((conversation) => {
    const agentId = text(conversation.personal_agent?.agent_id);
    const sessionId = text(conversation.legacy_session_id);
    if (conversation.kind !== 'ai' || !agentId || !sessionId || seen.has(agentId)) return [];
    seen.add(agentId);
    return [{ agentId, conversationId: conversation.id, sessionId, proactive: true }];
  });
}

/** Session ids of cached `ai` conversations whose snapshot has no `personal_agent` (Proactive off). */
export function markerlessSnapshotSessionIds(conversations: readonly ChatSyncConversation[]): Set<string> {
  return new Set(conversations.flatMap((conversation) => {
    const sessionId = text(conversation.legacy_session_id);
    return conversation.kind === 'ai' && sessionId && !text(conversation.personal_agent?.agent_id) ? [sessionId] : [];
  }));
}

/** Lists the owner's personal sessions (agents with Proactive on); the server creates any that are missing. */
export async function listPersonalAgentSessions(token: string): Promise<PersonalAgentSession[]> {
  return normalizePersonalAgentSessions(await defaultCloudAuthClient().request<unknown>(
    '/v1/cloud/personal-agents',
    { method: 'GET', headers: { authorization: `Bearer ${token}` } },
    'Could not load your personal agents.',
  ));
}

function settingPath(agentId: string) {
  return `/v1/cloud/agents/${encodeURIComponent(agentId)}/personal-agent`;
}

/** One connector the agent watches. */
export type PersonalAgentSource = { connectorId: string; provider: string; status: string };

/**
 * One agent's Proactive setting as its owner sees it. `proactive` is the
 * setting in effect, so it is false while `connected` is: the agent needs a
 * live connector granted to it before it can be turned on.
 */
export type PersonalAgentStatus = {
  proactive: boolean;
  connected: boolean;
  sources: PersonalAgentSource[];
  /** When the agent last looked at new events, while it is on. */
  checkedAt: string | null;
  /** What it shared recently, newest first. */
  recent: Array<{ at: string; text: string }>;
};

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object') : [];
}

export function normalizePersonalAgentStatus(body: unknown): PersonalAgentStatus {
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const sources = list(record.sources).flatMap((source) => {
    const connectorId = text(source.connectorId);
    const provider = text(source.provider);
    return connectorId && provider ? [{ connectorId, provider, status: text(source.status) }] : [];
  });
  // Older servers answer `{proactive}` only: a setting that is on had something to watch.
  const connected = typeof record.connected === 'boolean' ? record.connected : record.proactive === true;
  return {
    proactive: record.proactive === true,
    connected,
    sources,
    checkedAt: text(record.checkedAt) || null,
    recent: list(record.recent).flatMap((entry) => {
      const at = text(entry.at);
      const message = text(entry.text);
      return at && message ? [{ at, text: message }] : [];
    }),
  };
}

/** The agent's Proactive setting and what it watches. Owner only. */
export async function getPersonalAgentSetting(token: string, agentId: string): Promise<PersonalAgentStatus> {
  return normalizePersonalAgentStatus(await defaultCloudAuthClient().request<unknown>(
    settingPath(agentId),
    { method: 'GET', headers: { authorization: `Bearer ${token}` } },
    'Could not load the Proactive setting.',
  ));
}

/** The server refuses Proactive for an agent with no live connector granted to it. */
export const PERSONAL_AGENT_NEEDS_CONNECTOR = 'personal_agent_needs_connector';

/** Turns reaching out on or off. Owner only; turning it on needs a connector. */
export async function setPersonalAgentSetting(token: string, agentId: string, proactive: boolean): Promise<PersonalAgentStatus> {
  return normalizePersonalAgentStatus(await defaultCloudAuthClient().request<unknown>(
    settingPath(agentId),
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ proactive }),
    },
    'Could not update the Proactive setting.',
  ));
}
