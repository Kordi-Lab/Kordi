// The people the signed-in owner stopped from using their agents
// (docs/contact-permissions.md). The Mac applies the same rules as the cloud
// route: it never answers their requests and never reads their messages
// into the context of a run it executes.

import { CloudAuthError } from './cloudAuthError';
import { fetchRestrictedPeople } from './contactPermissionsClient';
import type { FetchContactProfileOptions } from './contactProfileClient';

const FRESH_MS = 15_000;

let known: { ids: Set<string>; loadedAt: number } | null = null;
let loading: Promise<ReadonlySet<string>> | null = null;

/**
 * Account ids the owner stopped from using their agents, refreshed every 15 seconds. A server
 * without the route restricts nobody; a failed refresh keeps the last known list.
 */
export async function agentRestrictedAccountIds(
  options: FetchContactProfileOptions = {},
  now: () => number = Date.now,
): Promise<ReadonlySet<string>> {
  if (known && now() - known.loadedAt < FRESH_MS) return known.ids;
  if (loading) return loading;
  loading = fetchRestrictedPeople(options).then(
    (people) => {
      known = { ids: new Set(people.filter((p) => !p.agentAccess).map((p) => p.accountId)), loadedAt: now() };
      return known.ids;
    },
    (error: unknown) => {
      if (error instanceof CloudAuthError && error.status === 404) {
        known = { ids: new Set(), loadedAt: now() };
        return known.ids;
      }
      return known?.ids ?? new Set<string>();
    },
  ).finally(() => { loading = null; });
  return loading;
}

/** Applies a switch the owner just saved, without waiting for the next refresh. */
export function noteAgentAccess(accountId: string, agentAccess: boolean): void {
  const ids = new Set(known?.ids ?? []);
  if (agentAccess) ids.delete(accountId);
  else ids.add(accountId);
  known = { ids, loadedAt: known?.loadedAt ?? 0 };
}

/** The generic refusal the server gives for an agent the requester may not use. */
export function isAgentUnavailableRefusal(error: unknown): boolean {
  return error instanceof CloudAuthError && error.status === 403 && error.code === 'agent_not_available';
}

export function resetAgentRestrictionsForTests(): void {
  known = null;
  loading = null;
}
