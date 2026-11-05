import { useEffect, useSyncExternalStore } from 'react';

import { defaultCloudAuthClient, type CloudAuthClient } from './authClient';
import { loadSession } from './session';

export type CloudOrganizationRole = 'owner' | 'admin' | 'member';
export type CloudOrganization = {
  organizationId: string;
  name: string;
  kind: 'personal' | 'team';
  role: CloudOrganizationRole;
  memberCount: number;
  createdAt: string;
};
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
};
export type UsageNotice = { threshold: 75 | 90; at: string };
export type OrganizationUsage = {
  organizationId: string;
  role: CloudOrganizationRole | null;
  snapshots: UsageSnapshot[];
  notices: UsageNotice[];
};
export type ConversationUsage = {
  organizationId: string | null;
  role: CloudOrganizationRole | null;
  snapshots: UsageSnapshot[];
  paused: { reached: UsageReached; resetsAt: string; since: string } | null;
};

export type UsageClient = {
  listOrganizations(token: string): Promise<CloudOrganization[]>;
  organizationUsage(token: string, organizationId: string): Promise<OrganizationUsage>;
  conversationUsage(token: string, conversationId: string): Promise<ConversationUsage>;
};

export function createUsageClient(client: Pick<CloudAuthClient, 'request'> = defaultCloudAuthClient()): UsageClient {
  const get = <T>(path: string, token: string) => client.request<T>(
    path,
    { headers: { authorization: `Bearer ${token}` } },
    'Could not load usage.',
  );
  return {
    async listOrganizations(token) {
      return (await get<{ organizations: CloudOrganization[] }>('/v1/cloud/organizations', token)).organizations ?? [];
    },
    organizationUsage: (token, organizationId) => get(`/v1/cloud/organizations/${encodeURIComponent(organizationId)}/usage`, token),
    conversationUsage: (token, conversationId) => get(`/v1/cloud/conversations/${encodeURIComponent(conversationId)}/usage`, token),
  };
}

// Organizations per account, for role lookups from chat lines and the Usage panel.
const ORGANIZATIONS_TTL_MS = 5 * 60_000;
const cachedOrganizationsByAccount = new Map<string, { organizations: CloudOrganization[]; loadedAtMs: number }>();
const pendingByAccount = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let activeAccountId: string | null = null;
let revision = 0;

function notify() {
  revision += 1;
  listeners.forEach((listener) => listener());
}

/** Stores an account's organizations; the Usage panel and previews call this.
 * The signed-in account (set by ensureOrganizations) stays the one role lookups use. */
export function primeOrganizations(accountId: string, organizations: CloudOrganization[]): void {
  cachedOrganizationsByAccount.set(accountId, { organizations, loadedAtMs: Date.now() });
  activeAccountId ??= accountId;
  notify();
}

export function cachedOrganizations(accountId: string): CloudOrganization[] | undefined {
  return cachedOrganizationsByAccount.get(accountId)?.organizations;
}

/** Loads the signed-in account's organizations once per TTL. Failures keep the previous cache. */
export async function ensureOrganizations(
  sessionLoader: typeof loadSession = loadSession,
  client: Pick<UsageClient, 'listOrganizations'> = createUsageClient(),
): Promise<void> {
  const session = await sessionLoader().catch(() => null);
  if (!session?.token || !session.accountId) return;
  const { accountId } = session;
  if (activeAccountId !== accountId) {
    activeAccountId = accountId;
    notify();
  }
  const cached = cachedOrganizationsByAccount.get(accountId);
  if (cached && Date.now() - cached.loadedAtMs < ORGANIZATIONS_TTL_MS) return;
  const pending = pendingByAccount.get(accountId);
  if (pending) return pending;
  const load = client.listOrganizations(session.token)
    .then((organizations) => primeOrganizations(accountId, organizations))
    .catch(() => {
      // Mark the attempt so the line settles on the member copy until the next TTL.
      if (!cachedOrganizationsByAccount.has(accountId)) {
        cachedOrganizationsByAccount.set(accountId, { organizations: [], loadedAtMs: Date.now() });
        notify();
      }
    })
    .finally(() => pendingByAccount.delete(accountId));
  pendingByAccount.set(accountId, load);
  return load;
}

/** The viewer's role in an organization: undefined while loading, null when not a member. */
export function organizationRole(organizationId: string | null | undefined): CloudOrganizationRole | null | undefined {
  if (!activeAccountId) return undefined;
  const organizations = cachedOrganizationsByAccount.get(activeAccountId)?.organizations;
  if (!organizations) return undefined;
  if (!organizationId) return null;
  return organizations.find((organization) => organization.organizationId === organizationId)?.role ?? null;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useOrganizationRole(organizationId: string | null | undefined): CloudOrganizationRole | null | undefined {
  useSyncExternalStore(subscribe, () => revision, () => revision);
  useEffect(() => { void ensureOrganizations(); }, []);
  return organizationRole(organizationId);
}

export function __resetUsageCacheForTests(): void {
  cachedOrganizationsByAccount.clear();
  pendingByAccount.clear();
  activeAccountId = null;
  notify();
}

/** HH:mm of an ISO time in UTC; 00:00 for a missing or malformed value. */
export function formatUtcClock(iso: string | null | undefined): string {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return '00:00';
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
}
