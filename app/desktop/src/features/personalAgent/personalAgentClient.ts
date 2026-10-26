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
 * The personal sessions named by cached chat-sync snapshots (`personal_agent`),
 * used until the server list loads. Their Proactive setting is unknown here.
 */
export function personalAgentSessionsFromSnapshots(conversations: readonly ChatSyncConversation[]): PersonalAgentSession[] {
  const seen = new Set<string>();
  return conversations.flatMap((conversation) => {
    const agentId = text(conversation.personal_agent?.agent_id);
    const sessionId = text(conversation.legacy_session_id);
    if (conversation.kind !== 'ai' || !agentId || !sessionId || seen.has(agentId)) return [];
    seen.add(agentId);
    return [{ agentId, conversationId: conversation.id, sessionId, proactive: false }];
  });
}

/** Lists the owner's personal sessions; the server creates any that are missing. */
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

function personalAgentSetting(body: unknown): { proactive: boolean } {
  return { proactive: Boolean(body && typeof body === 'object' && (body as { proactive?: unknown }).proactive === true) };
}

/** Whether the agent may reach out first in its personal session. Owner only. */
export async function getPersonalAgentSetting(token: string, agentId: string): Promise<{ proactive: boolean }> {
  return personalAgentSetting(await defaultCloudAuthClient().request<unknown>(
    settingPath(agentId),
    { method: 'GET', headers: { authorization: `Bearer ${token}` } },
    'Could not load the Proactive setting.',
  ));
}

/** Turns reaching out in the personal session on or off. Owner only. */
export async function setPersonalAgentSetting(token: string, agentId: string, proactive: boolean): Promise<{ proactive: boolean }> {
  return personalAgentSetting(await defaultCloudAuthClient().request<unknown>(
    settingPath(agentId),
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ proactive }),
    },
    'Could not update the Proactive setting.',
  ));
}
