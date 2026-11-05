// A server refused an organization the desktop sent (the account may have left
// it). Refreshing the list drops it, and the selection falls back to personal.
import { getOrganizationState } from './organizationStore';
import { forgetSessionOrganization, recordedSessionOrganizationId } from './sessionOrganization';
import { refreshOrganizations } from './useOrganizations';

type OrganizationRefresh = (accountId: string) => Promise<void>;

const defaultRefresh: OrganizationRefresh = (accountId) => refreshOrganizations(accountId, { force: true });
let refresh = defaultRefresh;

export function setOrganizationRefreshForTests(next: OrganizationRefresh | null): void {
  refresh = next ?? defaultRefresh;
}

/** Refreshes the account's organizations; true when the refreshed list no longer has this one. */
export async function organizationNoLongerAvailable(accountId: string, organizationId: string): Promise<boolean> {
  const account = accountId.trim();
  if (!account) return false;
  await refresh(account).catch(() => {});
  const state = getOrganizationState();
  // An empty list was never loaded (a loaded one always has the personal organization).
  return state.accountId === account && state.organizations.length > 0
    && !state.organizations.some((organization) => organization.organizationId === organizationId);
}

/** After a 403 on a create that carried an organization, refresh so a lost selection falls back to personal. */
export function refreshAfterOrganizationForbidden(
  accountId: string | null | undefined,
  organizationId: string | undefined,
  status: number | null | undefined,
): void {
  if (status === 403 && organizationId && accountId) void organizationNoLongerAvailable(accountId, organizationId);
}

/**
 * Creates a group or AI conversation in the organization recorded for its
 * session. When the server refuses it and the account no longer belongs to
 * that organization, retries once in the personal organization.
 */
export async function createInSessionOrganization<T>(
  input: { kind: string; accountId: string; sessionId: string; errorStatus: (error: unknown) => number | null },
  create: (organization: { organization_id?: string }) => Promise<T>,
): Promise<T> {
  const { kind, accountId, sessionId } = input;
  const organizationId = kind === 'direct' ? null : recordedSessionOrganizationId(accountId, sessionId);
  if (!organizationId) return create({});
  try {
    const created = await create({ organization_id: organizationId });
    forgetSessionOrganization(accountId, sessionId);
    return created;
  } catch (error) {
    if (input.errorStatus(error) !== 403 || !(await organizationNoLongerAvailable(accountId, organizationId))) {
      throw error;
    }
    forgetSessionOrganization(accountId, sessionId);
    return create({});
  }
}
