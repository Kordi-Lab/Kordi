import { useSyncExternalStore } from 'react';
import { isBrowserAppRuntime } from '@web/auth/browserAppRuntime';
import { getOrganizationState, subscribeOrganizationState } from '@/features/organizations/organizationStore';

export function browserWorkspaceScope(accountId: string | null, organizationId: string | null): string {
  return JSON.stringify([accountId, organizationId]);
}

let currentScope = 'browser';

function subscribe(listener: () => void): () => void {
  if (!isBrowserAppRuntime()) return () => undefined;
  const update = () => {
    const state = getOrganizationState();
    // Hooks inside the shell briefly report no account while mounting. That
    // transient reset must not remount the shell that is still restoring it.
    if (!state.accountId || !state.selectedOrganizationId) return;
    const next = browserWorkspaceScope(state.accountId, state.selectedOrganizationId);
    if (next === currentScope) return;
    currentScope = next;
    listener();
  };
  const unsubscribe = subscribeOrganizationState(update);
  update();
  return unsubscribe;
}

function snapshot(): string {
  return isBrowserAppRuntime() ? currentScope : 'desktop';
}

/** Organization selection publishes only after cookie exchange succeeds. Remount
 * account-scoped hooks together, so old transcript requests cannot fill the new
 * organization's view. Native storage keeps its existing lifecycle. */
export function useBrowserWorkspaceScope(): string {
  return useSyncExternalStore(subscribe, snapshot, () => 'desktop');
}
