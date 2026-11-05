// Which organization new content is created in. Selection is per account and
// stored under its own key; it never touches sign-in state, tokens or any
// local session, transcript or model data.
import type { CloudOrganization } from './organizationClient';

export type OrganizationStorage = Pick<Storage, 'getItem' | 'setItem'>;

export type OrganizationState = {
  accountId: string | null;
  organizations: CloudOrganization[];
  selectedOrganizationId: string | null;
};

const EMPTY_STATE: OrganizationState = { accountId: null, organizations: [], selectedOrganizationId: null };
let state: OrganizationState = EMPTY_STATE;
const listeners = new Set<() => void>();

export function organizationSelectionKey(accountId: string): string {
  return `kordi.organization.selected.${accountId.trim()}`;
}

export function defaultStorage(): OrganizationStorage | null {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

export function readStoredOrganizationId(
  accountId: string,
  storage: OrganizationStorage | null = defaultStorage(),
): string | null {
  try {
    return storage?.getItem(organizationSelectionKey(accountId))?.trim() || null;
  } catch {
    return null;
  }
}

function writeStoredOrganizationId(
  accountId: string,
  organizationId: string,
  storage: OrganizationStorage | null,
): void {
  try {
    storage?.setItem(organizationSelectionKey(accountId), organizationId);
  } catch {
    // Selection still applies for this run.
  }
}

/** The stored organization when the account still belongs to it, otherwise the personal one. */
export function resolveSelectedOrganizationId(
  organizations: CloudOrganization[],
  storedOrganizationId: string | null,
): string | null {
  if (storedOrganizationId && organizations.some((item) => item.organizationId === storedOrganizationId)) {
    return storedOrganizationId;
  }
  return organizations.find((item) => item.kind === 'personal')?.organizationId ?? null;
}

function publish(next: OrganizationState): void {
  state = next;
  listeners.forEach((listener) => listener());
}

export function getOrganizationState(): OrganizationState {
  return state;
}

export function subscribeOrganizationState(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setAccountOrganizations(
  accountId: string,
  organizations: CloudOrganization[],
  storage: OrganizationStorage | null = defaultStorage(),
): void {
  const normalized = accountId.trim();
  if (!normalized) return;
  publish({
    accountId: normalized,
    organizations,
    selectedOrganizationId: resolveSelectedOrganizationId(
      organizations,
      readStoredOrganizationId(normalized, storage),
    ),
  });
}

export function selectOrganization(
  accountId: string,
  organizationId: string,
  storage: OrganizationStorage | null = defaultStorage(),
): void {
  const normalized = accountId.trim();
  if (normalized !== state.accountId) return;
  if (!state.organizations.some((item) => item.organizationId === organizationId)) return;
  writeStoredOrganizationId(normalized, organizationId, storage);
  publish({ ...state, selectedOrganizationId: organizationId });
}

/** Starts tracking an account (or none) with no organizations known yet: new content stays personal. */
export function resetOrganizationAccount(accountId: string | null): void {
  const normalized = accountId?.trim() || null;
  if (state.accountId === normalized) return;
  publish(normalized ? { ...EMPTY_STATE, accountId: normalized } : EMPTY_STATE);
}

/**
 * The team organization new content belongs to, or null for the personal
 * organization (the server default) and whenever the selection is unknown.
 */
export function organizationIdForNewContent(accountId?: string | null): string | null {
  const expected = accountId?.trim();
  if (!state.accountId || (expected && expected !== state.accountId)) return null;
  const selected = state.organizations.find((item) => item.organizationId === state.selectedOrganizationId);
  return selected?.kind === 'team' ? selected.organizationId : null;
}

/** `organizationId` for a new Agent or scheduled task; nothing without the signed-in account. */
export function organizationIdField(accountId: string | null | undefined): { organizationId?: string } {
  const organizationId = accountId?.trim() ? organizationIdForNewContent(accountId) : null;
  return organizationId ? { organizationId } : {};
}
