import { defaultCloudAuthClient, type CloudAuthClient } from './authClient';

export type CloudOrganizationRole = 'owner' | 'admin' | 'member';
export type UsageLimitId = 'conversation.system_agent_runs' | 'account.grounding_runs' | 'pool.runs' | 'pool.spend' | 'pool.stopped';
export type UsageReached = 'none' | 'daily_limit' | 'spend_limit' | 'stopped';
export type UsageSnapshot = {
  limitId: UsageLimitId;
  scope: 'pool' | 'conversation' | 'account';
  used?: number;
  limit?: number;
  usedPercent: number;
  window: 'day';
  resetsAt: string;
  reached: UsageReached;
  /** On `conversation.system_agent_runs`: the caller's busiest conversation today. */
  conversationId?: string;
  /** When a limit refused the System agent in this window. */
  pausedSince?: string;
};
export type OrganizationUsageSummary = {
  organizationId: string;
  name: string;
  kind: 'personal' | 'team';
  role: CloudOrganizationRole;
  snapshots: UsageSnapshot[];
};
export type OrganizationUsage = {
  organizationId: string;
  role: CloudOrganizationRole | null;
  snapshots: UsageSnapshot[];
};

export type UsageClient = {
  /** Every organization the account belongs to, personal first. */
  accountUsage(token: string): Promise<OrganizationUsageSummary[]>;
  organizationUsage(token: string, organizationId: string): Promise<OrganizationUsage>;
};

export function createUsageClient(client: Pick<CloudAuthClient, 'request'> = defaultCloudAuthClient()): UsageClient {
  const get = <T>(path: string, token: string) => client.request<T>(
    path,
    { headers: { authorization: `Bearer ${token}` } },
    'Could not load usage.',
  );
  return {
    async accountUsage(token) {
      return (await get<{ organizations?: OrganizationUsageSummary[] }>('/v1/cloud/account/usage', token)).organizations ?? [];
    },
    organizationUsage: (token, organizationId) => get(`/v1/cloud/organizations/${encodeURIComponent(organizationId)}/usage`, token),
  };
}

/** HH:mm of an ISO time in UTC; 00:00 for a missing or malformed value. */
export function formatUtcClock(iso: string | null | undefined): string {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return '00:00';
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
}
