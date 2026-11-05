// Recovers from `409 organization_mismatch`: refreshes the organization list
// (which also brings the token to the selection), switches the token when it
// still acts elsewhere, and returns the token to send the request with once
// more. Concurrent mismatches share one recovery.
import { loadSession, switchSessionOrganization, type StoredSession } from '@/features/cloud/session';
import { getOrganizationState } from './organizationStore';
import { refreshOrganizations } from './useOrganizations';

export type OrganizationMismatchDeps = {
  loadSession: () => Promise<StoredSession | null>;
  refreshOrganizations: (accountId: string) => Promise<void>;
  switchSession: (organizationId: string) => Promise<StoredSession>;
};

const defaultDeps: OrganizationMismatchDeps = {
  loadSession,
  refreshOrganizations: (accountId) => refreshOrganizations(accountId, { force: true }),
  switchSession: switchSessionOrganization,
};

let recovery: Promise<{ accountId: string; token: string } | null> | null = null;

export function recoverOrganizationMismatch(
  tokenOrganizationId: string | null,
  failedToken: string,
  deps: OrganizationMismatchDeps = defaultDeps,
): Promise<{ accountId: string; token: string } | null> {
  if (recovery) return recovery;
  const promise = runRecovery(tokenOrganizationId, failedToken, deps)
    .catch(() => null)
    .finally(() => {
      if (recovery === promise) recovery = null;
    });
  recovery = promise;
  return promise;
}

async function runRecovery(
  tokenOrganizationId: string | null,
  failedToken: string,
  deps: OrganizationMismatchDeps,
): Promise<{ accountId: string; token: string } | null> {
  const first = await deps.loadSession();
  if (!first) return null;
  const accountId = first.accountId;
  await deps.refreshOrganizations(accountId);
  const state = getOrganizationState();
  const selected = state.accountId === accountId ? state.selectedOrganizationId : null;
  let session = await deps.loadSession();
  if (!selected || !session || session.accountId !== accountId) return null;
  if (tokenOrganizationId && tokenOrganizationId !== selected && session.token === failedToken) {
    // The stored token still acts in the organization the server named.
    try {
      session = await deps.switchSession(selected);
    } catch {
      return null;
    }
    if (session.accountId !== accountId) return null;
  }
  return { accountId, token: session.token };
}
