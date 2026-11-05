import { useCallback, useEffect, useSyncExternalStore } from 'react';

import { loadSession, type StoredSession } from '@/features/cloud/session';
import { fetchCloudOrganizations, type CloudOrganization } from './organizationClient';
import {
  getOrganizationState,
  resetOrganizationAccount,
  selectOrganization,
  setAccountOrganizations,
  subscribeOrganizationState,
  type OrganizationState,
} from './organizationStore';

/** Opening the account menu refreshes at most this often. */
const ORGANIZATION_REFRESH_INTERVAL_MS = 30_000;

export type OrganizationRefreshDeps = {
  loadSession: () => Promise<StoredSession | null>;
  fetchOrganizations: (token: string) => Promise<CloudOrganization[]>;
  now: () => number;
};

const defaultDeps: OrganizationRefreshDeps = {
  loadSession,
  fetchOrganizations: (token) => fetchCloudOrganizations(token),
  now: () => Date.now(),
};

let inFlight: { accountId: string; promise: Promise<void> } | null = null;
let lastRefresh: { accountId: string; at: number } | null = null;

/** Fetches the account's organizations. Failures are silent and keep the current selection. */
export function refreshOrganizations(
  accountId: string,
  { force = false, deps = defaultDeps }: { force?: boolean; deps?: OrganizationRefreshDeps } = {},
): Promise<void> {
  const normalized = accountId.trim();
  if (!normalized) return Promise.resolve();
  if (inFlight?.accountId === normalized) return inFlight.promise;
  if (
    !force
    && lastRefresh?.accountId === normalized
    && deps.now() - lastRefresh.at < ORGANIZATION_REFRESH_INTERVAL_MS
  ) {
    return Promise.resolve();
  }
  const promise = (async () => {
    try {
      const session = await deps.loadSession();
      if (!session?.token || session.accountId !== normalized) return;
      const organizations = await deps.fetchOrganizations(session.token);
      setAccountOrganizations(normalized, organizations);
      lastRefresh = { accountId: normalized, at: deps.now() };
    } catch {
      // Older servers and offline starts keep the personal organization.
    }
  })().finally(() => {
    if (inFlight?.promise === promise) inFlight = null;
  });
  inFlight = { accountId: normalized, promise };
  return promise;
}

export function resetOrganizationRefreshForTests(): void {
  inFlight = null;
  lastRefresh = null;
}

const EMPTY_ORGANIZATIONS: CloudOrganization[] = [];

/** Loads organizations after sign-in and whenever the account menu opens. */
export function useAccountOrganizations(
  accountId: string | null | undefined,
  menuOpen: boolean,
): Pick<OrganizationState, 'organizations' | 'selectedOrganizationId'> & {
  onSelect: (organizationId: string) => void;
} {
  const normalized = accountId?.trim() || null;
  const state = useSyncExternalStore(subscribeOrganizationState, getOrganizationState, getOrganizationState);
  const onSelect = useCallback((organizationId: string) => {
    if (normalized) selectOrganization(normalized, organizationId);
  }, [normalized]);

  useEffect(() => {
    resetOrganizationAccount(normalized);
    if (normalized) void refreshOrganizations(normalized, { force: true });
  }, [normalized]);

  useEffect(() => {
    if (normalized && menuOpen) void refreshOrganizations(normalized);
  }, [normalized, menuOpen]);

  return state.accountId === normalized && normalized
    ? { organizations: state.organizations, selectedOrganizationId: state.selectedOrganizationId, onSelect }
    : { organizations: EMPTY_ORGANIZATIONS, selectedOrganizationId: null, onSelect };
}
