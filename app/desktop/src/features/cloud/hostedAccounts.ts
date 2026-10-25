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
export type HostedAccountsState = {
  accounts: HostedAccount[];
  catalog: OmpCatalogEntry[];
  hasLoaded: boolean;
  /** True once a list actually arrived; a failed load leaves it false, so a missing account may still exist. */
  listed?: boolean;
};

// One list for the app: the Authentication page publishes every load, and the
// composer loads it once per Kordi session.
const emptyState: HostedAccountsState = { accounts: [], catalog: [], hasLoaded: false, listed: false };
let state: HostedAccountsState = emptyState;
let generation = 0;
const listeners = new Set<() => void>();

function update(next: Partial<HostedAccountsState>) {
  const merged = { ...state, ...next };
  if (merged.hasLoaded === state.hasLoaded && merged.listed === state.listed && merged.catalog === state.catalog
    && (merged.accounts === state.accounts || JSON.stringify(merged.accounts) === JSON.stringify(state.accounts))) return;
  state = merged;
  for (const listener of [...listeners]) listener();
}

// A failed load retries with backoff; the last delay repeats until a list arrives.
const RETRY_DELAYS_MS = [5_000, 15_000, 60_000];
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;

function cancelRetry() {
  if (retryTimer === null) return;
  clearTimeout(retryTimer);
  retryTimer = null;
}

function resetRetry() {
  cancelRetry();
  retryAttempt = 0;
}

function applySnapshots(snapshots: CloudProviderAuthSnapshot[]) {
  setHostedAccountChoices(snapshots.filter((snapshot) => !snapshot.revokedAt).map((snapshot) => snapshot.authChoice));
  update({ accounts: hostedAccountsFromSnapshots(snapshots), hasLoaded: true, listed: true });
}

export function publishHostedProviderSnapshots(snapshots: CloudProviderAuthSnapshot[]) {
  generation += 1;
  resetRetry();
  applySnapshots(snapshots);
}

/** The current hosted accounts, for event handlers outside React state. */
export function hostedAccountsState(): HostedAccountsState {
  return state;
}

/** Lists the signed-in account's snapshots; null when the fetch failed, empty when signed out. */
export type HostedSnapshotLoader = () => Promise<CloudProviderAuthSnapshot[] | null>;

async function listSnapshotsFromCloud(): Promise<CloudProviderAuthSnapshot[] | null> {
  const session = await loadSession().catch(() => null);
  if (!session) return [];
  return createCloudProviderAuthApi().listProviderAuthSnapshots(session.token, false).catch(() => null);
}

async function loadHostedAccounts(listSnapshots: HostedSnapshotLoader = listSnapshotsFromCloud) {
  cancelRetry();
  const started = ++generation;
  const snapshots = await listSnapshots().catch(() => null);
  // A newer load or a publish from the Authentication page wins.
  if (started !== generation) return;
  if (snapshots) {
    resetRetry();
    applySnapshots(snapshots);
    return;
  }
  update({ hasLoaded: true });
  const delay = RETRY_DELAYS_MS[Math.min(retryAttempt, RETRY_DELAYS_MS.length - 1)];
  retryAttempt += 1;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void loadHostedAccounts(listSnapshots);
  }, delay);
}

/** Loads the hosted accounts again now; a failed load keeps retrying with backoff. */
export function reloadHostedAccounts(listSnapshots?: HostedSnapshotLoader): Promise<void> {
  return loadHostedAccounts(listSnapshots);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Subscribe to account changes without starting another network load. */
export function useHostedAccountsSnapshot(): HostedAccountsState {
  return useSyncExternalStore(subscribe, () => state, () => emptyState);
}

/** Hosted accounts of the signed-in Kordi account; empty outside the desktop shell. */
export function useHostedAccounts(enabled: boolean): HostedAccountsState {
  const current = useHostedAccountsSnapshot();
  useEffect(() => {
    if (!enabled) return;
    void loadHostedAccounts();
    void loadPinnedOmpCatalog().then((catalog) => update({ catalog: catalog.providers })).catch(() => undefined);
    const reload = () => { void loadHostedAccounts(); };
    const reloadIfUnlisted = () => { if (!state.listed) reload(); };
    const clear = () => { generation += 1; resetRetry(); applySnapshots([]); };
    if (typeof window === 'undefined') return cancelRetry;
    window.addEventListener(CLOUD_SESSION_CHANGED_EVENT, reload);
    window.addEventListener(CLOUD_SESSION_SIGNED_OUT_EVENT, clear);
    window.addEventListener('focus', reloadIfUnlisted);
    return () => {
      cancelRetry();
      window.removeEventListener(CLOUD_SESSION_CHANGED_EVENT, reload);
      window.removeEventListener(CLOUD_SESSION_SIGNED_OUT_EVENT, clear);
      window.removeEventListener('focus', reloadIfUnlisted);
    };
  }, [enabled]);
  return enabled ? current : emptyState;
}
