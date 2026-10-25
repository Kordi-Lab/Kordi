import { CloudAuthError, defaultCloudAuthClient } from './authClient';
import { normalizeProactiveActivity, type ProactiveActivityEntry } from './proactiveOffer';

export type ProactiveDecision = 'allow' | 'decline';

function agentPath(agentId: string) {
  return `/v1/cloud/agents/${encodeURIComponent(agentId)}/proactive`;
}

/** Allows or declines one pending proactive offer as the agent's owner. Returns the proposal. */
export async function decideProactiveProposal(
  token: string,
  agentId: string,
  proposalId: string,
  decision: ProactiveDecision,
): Promise<unknown> {
  try {
    return await defaultCloudAuthClient().request<unknown>(
      `${agentPath(agentId)}/proposals/${encodeURIComponent(proposalId)}/decision`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ decision }),
      },
      'Could not update this offer.',
    );
  } catch (error) {
    if (error instanceof CloudAuthError && error.status === 409) {
      throw new CloudAuthError(error.code, 'This offer is no longer open.', 409);
    }
    throw error;
  }
}

/** The agent's recent proactive evaluations, newest first. */
export async function listProactiveActivity(token: string, agentId: string, limit = 50): Promise<ProactiveActivityEntry[]> {
  const body = await defaultCloudAuthClient().request<unknown>(
    `${agentPath(agentId)}/activity?limit=${encodeURIComponent(String(limit))}`,
    { method: 'GET', headers: { authorization: `Bearer ${token}` } },
    'Could not load proactive activity.',
  );
  return normalizeProactiveActivity(body);
}

/** The server id of the owner's default agent ("my Kordi"). */
export function defaultAgentProactiveId(accountId: string) {
  return `cloud-agent:${accountId}`;
}

function proactiveSetting(body: unknown): { enabled: boolean } {
  return { enabled: Boolean(body && typeof body === 'object' && (body as { enabled?: unknown }).enabled === true) };
}

/** Whether the agent watches its owner's groups. Owner only. */
export async function getProactiveSetting(token: string, agentId: string): Promise<{ enabled: boolean }> {
  return proactiveSetting(await defaultCloudAuthClient().request<unknown>(
    agentPath(agentId),
    { method: 'GET', headers: { authorization: `Bearer ${token}` } },
    'Could not load the proactive setting.',
  ));
}

/** Turns the agent's proactive watching on or off. Owner only. */
export async function setProactiveSetting(token: string, agentId: string, enabled: boolean): Promise<{ enabled: boolean }> {
  return proactiveSetting(await defaultCloudAuthClient().request<unknown>(
    agentPath(agentId),
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ enabled }),
    },
    'Could not update the proactive setting.',
  ));
}
