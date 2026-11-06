import { defaultCloudAuthClient } from './authClient';
import type { CloudAgentAccessScope } from './cloudAgentsClient';

// Agent Access for any agent its owner can edit: a Factory agent id or the
// default agent, `cloud-agent:<accountId>` (docs/contact-permissions.md).

function accessPath(agentId: string) {
  return `/v1/cloud/agents/${encodeURIComponent(agentId)}/access`;
}

/** A missing or unknown value means people in the owner's chats can use the agent. */
export function normalizeAgentAccessScope(value: unknown): CloudAgentAccessScope {
  return value === 'private' ? 'private' : 'participant_conversations';
}

function accessScope(body: unknown): CloudAgentAccessScope {
  return normalizeAgentAccessScope(body && typeof body === 'object' ? (body as { accessScope?: unknown }).accessScope : undefined);
}

/** The agent's Access. Owner only. */
export async function getAgentAccess(token: string, agentId: string): Promise<CloudAgentAccessScope> {
  return accessScope(await defaultCloudAuthClient().request<unknown>(
    accessPath(agentId),
    { method: 'GET', headers: { authorization: `Bearer ${token}` } },
    'Could not load agent access.',
  ));
}

/** Changes the agent's Access. Owner only. */
export async function setAgentAccess(token: string, agentId: string, scope: CloudAgentAccessScope): Promise<CloudAgentAccessScope> {
  return accessScope(await defaultCloudAuthClient().request<unknown>(
    accessPath(agentId),
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ accessScope: scope }),
    },
    'Could not update agent access.',
  ));
}
