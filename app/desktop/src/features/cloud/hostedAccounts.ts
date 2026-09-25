import { useEffect, useSyncExternalStore } from 'react';
import { loadPinnedOmpCatalog, type OmpCatalogEntry } from '@/kordi-app/auth/ompCatalog';
import type { CloudProviderAuthSnapshot } from './cloudAgentRuntimeTypes';
import { setHostedAccountChoices } from './hostedAccountRegistry';
import { createCloudProviderAuthApi } from './providerAuthClient';
import { CLOUD_SESSION_CHANGED_EVENT, CLOUD_SESSION_SIGNED_OUT_EVENT, loadSession } from './session';

/** An account stored in the Kordi account, as its snapshot names it; the credential stays on the server. */
export type HostedAccount = {
  authChoice: string;
  label: string;
  /** The snapshot's provider, for example openai-codex, cerebras or custom. */
  provider: string;
  /** The model the account stores, required for Custom API accounts. */
  model: string | null;
  /** The hosted copy can no longer sign in; the owner has to reconnect it. */
  needsReconnect: boolean;
};

export function hostedAccountsFromSnapshots(snapshots: CloudProviderAuthSnapshot[]): HostedAccount[] {
  return snapshots
    .filter((snapshot) => !snapshot.revokedAt)
    .map((snapshot) => ({
      authChoice: snapshot.authChoice,
      label: snapshot.label?.trim() || (snapshot.provider === 'custom' ? 'Custom API' : 'Saved account'),
      provider: snapshot.provider,
      model: snapshot.modelHint?.trim() || null,
      needsReconnect: snapshot.status === 'needs-reconnect' || snapshot.status === 'needs_reconnect',
    }));
}

/** Hosted accounts and the pinned OMP catalog that lists their providers' models. */
export type HostedAccountsState = { accounts: HostedAccount[]; catalog: OmpCatalogEntry[] };

// One list for the app: the Authentication page publishes every load, and the
// composer loads it once per Kordi session.
const emptyState: HostedAccountsState = { accounts: [], catalog: [] };
let state: HostedAccountsState = emptyState;
let generation = 0;
const listeners = new Set<() => void>();

function update(next: Partial<HostedAccountsState>) {
  const merged = { ...state, ...next };
  if (merged.accounts === state.accounts && merged.catalog === state.catalog) return;
  if (JSON.stringify(merged.accounts) === JSON.stringify(state.accounts) && merged.catalog === state.catalog) return;
  state = merged;
  for (const listener of [...listeners]) listener();
}

function applySnapshots(snapshots: CloudProviderAuthSnapshot[]) {
  setHostedAccountChoices(snapshots.filter((snapshot) => !snapshot.revokedAt).map((snapshot) => snapshot.authChoice));
  update({ accounts: hostedAccountsFromSnapshots(snapshots) });
}

export function publishHostedProviderSnapshots(snapshots: CloudProviderAuthSnapshot[]) {
  generation += 1;
  applySnapshots(snapshots);
}

/** The current hosted accounts, for event handlers outside React state. */
export function hostedAccountsState(): HostedAccountsState {
  return state;
}

async function loadHostedAccounts() {
  const started = ++generation;
  const session = await loadSession().catch(() => null);
  const snapshots = session
    ? await createCloudProviderAuthApi().listProviderAuthSnapshots(session.token, false).catch(() => null)
    : [];
  // A newer load or a publish from the Authentication page wins.
  if (snapshots && started === generation) applySnapshots(snapshots);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Hosted accounts of the signed-in Kordi account; empty outside the desktop shell. */
export function useHostedAccounts(enabled: boolean): HostedAccountsState {
  const current = useSyncExternalStore(subscribe, () => state, () => emptyState);
  useEffect(() => {
    if (!enabled) return;
    void loadHostedAccounts();
    void loadPinnedOmpCatalog().then((catalog) => update({ catalog: catalog.providers })).catch(() => undefined);
    const reload = () => { void loadHostedAccounts(); };
    const clear = () => { generation += 1; applySnapshots([]); };
    window.addEventListener(CLOUD_SESSION_CHANGED_EVENT, reload);
    window.addEventListener(CLOUD_SESSION_SIGNED_OUT_EVENT, clear);
    return () => {
      window.removeEventListener(CLOUD_SESSION_CHANGED_EVENT, reload);
      window.removeEventListener(CLOUD_SESSION_SIGNED_OUT_EVENT, clear);
    };
  }, [enabled]);
  return enabled ? current : emptyState;
}
