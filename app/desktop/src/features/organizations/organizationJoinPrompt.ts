// When the "find your organization" dialog opens by itself: once after
// sign-in, while the account has an organization it can join that it has not
// joined, requested or dismissed. Closing the dialog dismisses everything it
// listed, remembered per account. Settings › Account opens it on request.
import type { JoinableOrganization, JoinableOrganizations } from './organizationJoinClient';
import { defaultStorage, type OrganizationStorage } from './organizationStore';

export function organizationJoinDismissedKey(accountId: string): string {
  return `kordi.organization.joinDismissed.${accountId.trim()}`;
}

export function readDismissedJoinIds(
  accountId: string,
  storage: OrganizationStorage | null = defaultStorage(),
): Set<string> {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(organizationJoinDismissedKey(accountId)) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

export function rememberDismissedJoinIds(
  accountId: string,
  ids: Iterable<string>,
  storage: OrganizationStorage | null = defaultStorage(),
): void {
  const next = readDismissedJoinIds(accountId, storage);
  for (const id of ids) next.add(id);
  try {
    storage?.setItem(organizationJoinDismissedKey(accountId), JSON.stringify([...next]));
  } catch {
    // The dialog may open once more next time.
  }
}

/** Organizations worth opening the dialog for on its own. */
export function promptableOrganizations(
  data: JoinableOrganizations | null,
  dismissed: ReadonlySet<string>,
): JoinableOrganization[] {
  return (data?.organizations ?? []).filter((organization) => (
    !organization.requested
    && (organization.canJoin || organization.canRequest)
    && !dismissed.has(organization.id)
  ));
}

// Requests from Settings › Account to open the dialog.
const listeners = new Set<() => void>();

export function openOrganizationJoinDialog(): void {
  listeners.forEach((listener) => listener());
}

export function subscribeOrganizationJoinOpenRequests(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
