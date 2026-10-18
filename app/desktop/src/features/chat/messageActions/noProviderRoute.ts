import { routeRunsOnKordiCloud } from '@/features/cloud/cloudAgentRuntimeRoute';
import { registeredAccountChoices } from '@/features/cloud/hostedAccountRegistry';
import { hostedAccountsState } from '@/features/cloud/hostedAccounts';
import type { DesktopChatMessageRoute } from '@/lib/desktop';
import { fallbackHostedRouteAccount, hostedRouteAccounts, hostedRouteForChoice } from '../hostedComposerOptions';

/** How long a send waits for the account lists before deciding that no account exists. */
export const ACCOUNT_LISTS_WAIT_MS = 5_000;

/** True once both this Mac's and Kordi Cloud's account lists have arrived. */
export function accountListsLoaded() {
  return Boolean(hostedAccountsState().listed) && registeredAccountChoices().localChoices !== null;
}

/** Waits for both account lists, up to a limit; resolves false if they are still loading. */
export async function waitForAccountLists(timeoutMs = ACCOUNT_LISTS_WAIT_MS, stepMs = 100) {
  for (let waited = 0; !accountListsLoaded(); waited += stepMs) {
    if (waited >= timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return true;
}

/** The Kordi Cloud route a session without a usable account falls back to, from the loaded lists. */
export function kordiCloudFallbackRoute(selection: { model: string; thinking?: string | null }): DesktopChatMessageRoute | null {
  const { accounts, catalog } = hostedAccountsState();
  const account = fallbackHostedRouteAccount(hostedRouteAccounts(accounts, catalog, registeredAccountChoices().localChoices), selection.model);
  return account ? hostedRouteForChoice(account, { model: selection.model, thinking: selection.thinking, catalog }) : null;
}

/**
 * The route a send uses when this Mac has no signed-in provider: the
 * session's own Kordi Cloud route, else a usable Kordi Cloud account once the
 * account lists have arrived. Null only when no usable account exists, which
 * is the one case that answers "No provider configured yet".
 */
export async function routeForSendWithoutLocalProvider(
  route: DesktopChatMessageRoute | null,
  selection: { model: string; thinking: string },
): Promise<DesktopChatMessageRoute | null> {
  if (routeRunsOnKordiCloud(route)) return route;
  await waitForAccountLists();
  return kordiCloudFallbackRoute(selection);
}
