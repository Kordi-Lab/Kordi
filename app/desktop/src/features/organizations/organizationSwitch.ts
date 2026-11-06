// Keeps the session's access token in the selected organization. Selecting an
// organization exchanges the token first and applies the selection only when
// the exchange succeeds (or the token already acts there); a failed or
// unsupported exchange keeps the old token and selection.
// Never signs out, switches account, or touches local session data.
import { loadSession, switchSessionOrganization, type StoredSession } from '@/features/cloud/session';
import { getOrganizationState, selectOrganization } from './organizationStore';

export type OrganizationSwitchDeps = {
  loadSession: () => Promise<StoredSession | null>;
  switchSession: (organizationId: string) => Promise<StoredSession>;
};

const defaultDeps: OrganizationSwitchDeps = {
  loadSession,
  switchSession: switchSessionOrganization,
};

let latestSelection = 0;

/** The organization a session's token acts in; an unrecorded one is the personal organization. */
export function tokenOrganizationId(session: StoredSession): string | null {
  return session.organizationId
    ?? getOrganizationState().organizations.find((item) => item.kind === 'personal')?.organizationId
    ?? null;
}

/** Switches the token, then selects the organization. Resolves false when the selection stays as it was. */
export async function switchOrganization(
  accountId: string,
  organizationId: string,
  deps: OrganizationSwitchDeps = defaultDeps,
): Promise<boolean> {
  const account = accountId.trim();
  const state = getOrganizationState();
  if (account !== state.accountId || !state.organizations.some((item) => item.organizationId === organizationId)) {
    return false;
  }
  const selection = ++latestSelection;
  try {
    const session = await deps.loadSession();
    if (!session || session.accountId !== account) return false;
    // The server charges work to the token's organization, so the selection
    // follows the token: any failed exchange, `unsupported` included, keeps it.
    if (tokenOrganizationId(session) !== organizationId) await deps.switchSession(organizationId);
  } catch {
    return false;
  }
  if (selection !== latestSelection) return false;
  selectOrganization(account, organizationId);
  return getOrganizationState().selectedOrganizationId === organizationId;
}

/**
 * Brings the token to the selected organization after the list loads. When
 * that fails, the selection shows the token's organization for this run, so
 * new content is not created where the token cannot act.
 */
export async function alignSessionOrganization(
  accountId: string,
  deps: OrganizationSwitchDeps = defaultDeps,
): Promise<void> {
  const account = accountId.trim();
  const state = getOrganizationState();
  const selected = state.accountId === account ? state.selectedOrganizationId : null;
  if (!selected) return;
  const selection = latestSelection;
  let session: StoredSession | null;
  try {
    session = await deps.loadSession();
  } catch {
    return;
  }
  if (!session || session.accountId !== account) return;
  const tokenOrganization = tokenOrganizationId(session);
  if (tokenOrganization === selected) return;
  try {
    await deps.switchSession(selected);
  } catch {
    if (!tokenOrganization || selection !== latestSelection) return;
    if (getOrganizationState().selectedOrganizationId !== selected) return;
    // No storage: the stored selection is tried again on the next start.
    selectOrganization(account, tokenOrganization, null);
  }
}
