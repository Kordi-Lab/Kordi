import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { CloudAuthError } from '@/features/cloud/cloudAuthError';
import { loadSession } from '@/features/cloud/session';
import { CONNECTORS_SETTINGS_LINK_EVENT, type ConnectorsSettingsTarget } from '@/features/connectors/connectorsSettingsLink';
import { formatDesktopLastActiveLabel } from '@/lib/time';
import { getPersonalAgentSetting, setPersonalAgentSetting, type PersonalAgentStatus } from './personalAgentClient';
import { defaultPersonalAgentId } from './personalAgentEntries';
import { requestPersonalAgentsRefresh, subscribePersonalAgentsRefresh } from './personalAgentStore';

// The Personal agent entry and page show the owner's default agent: whether
// it can watch anything (a connector granted to it), whether it is on, what
// it watches and what it shared. Both read one shared snapshot.

type Snapshot = { accountId: string; status: PersonalAgentStatus } | null;

let snapshot: Snapshot = null;
let loading: Promise<void> | null = null;
/** Tests and login-free previews pin a status; nothing is loaded then. */
let pinned = false;
const listeners = new Set<() => void>();

function publish(next: Snapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function read() {
  return snapshot;
}

/** Loads the default agent's status again; concurrent calls share one request. */
export function refreshPersonalAgentStatus(): Promise<void> {
  if (pinned) return Promise.resolve();
  loading ??= (async () => {
    try {
      const session = await loadSession();
      if (!session?.token || !session.accountId) {
        publish(null);
        return;
      }
      const status = await getPersonalAgentSetting(session.token, defaultPersonalAgentId(session.accountId));
      publish({ accountId: session.accountId, status });
    } catch {
      // A failed read keeps the last status; the next refresh tries again.
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** Pins the default agent's status for tests and previews; null loads it again. */
export function __setDefaultPersonalAgentStatusForTests(status: PersonalAgentStatus | null) {
  pinned = status !== null;
  publish(status ? { accountId: 'preview', status } : null);
}

/** Turns the default agent's Proactive on or off. Without a connector the server refuses; the status then says so. */
export async function setDefaultPersonalAgentProactive(proactive: boolean) {
  if (pinned) {
    if (snapshot) publish({ ...snapshot, status: { ...snapshot.status, proactive: proactive && snapshot.status.connected } });
    return;
  }
  const session = await loadSession();
  if (!session?.token || !session.accountId) throw new Error('Sign in to change Personal agent.');
  try {
    const status = await setPersonalAgentSetting(session.token, defaultPersonalAgentId(session.accountId), proactive);
    publish({ accountId: session.accountId, status });
  } catch (error) {
    if (!(error instanceof CloudAuthError && error.status === 409)) throw error;
    await refreshPersonalAgentStatus();
  }
  // The local personal session follows the setting.
  requestPersonalAgentsRefresh();
}

/** The default agent's status, loaded on first use and whenever the personal agent list reloads. */
export function useDefaultPersonalAgentStatus(): PersonalAgentStatus | null {
  const current = useSyncExternalStore(subscribe, read, read);
  useEffect(() => {
    void refreshPersonalAgentStatus();
    return subscribePersonalAgentsRefresh(() => { void refreshPersonalAgentStatus(); });
  }, []);
  return current?.status ?? null;
}

/** One agent's status for its Blueprint, by server agent id; null while loading or when there is none. */
export function usePersonalAgentStatus(agentId: string | null): PersonalAgentStatus | null {
  const [state, setState] = useState<{ agentId: string; status: PersonalAgentStatus } | null>(null);
  const load = useCallback(async (id: string) => {
    const session = await loadSession();
    if (!session?.token) return null;
    return getPersonalAgentSetting(session.token, id);
  }, []);
  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    const run = () => {
      load(agentId).then((status) => { if (!cancelled && status) setState({ agentId, status }); }, () => undefined);
    };
    run();
    const stop = subscribePersonalAgentsRefresh(run);
    return () => { cancelled = true; stop(); };
  }, [agentId, load]);
  return state && state.agentId === agentId ? state.status : null;
}

/** Opens account settings on the Connectors tab. */
export function openConnectorsSettings() {
  window.dispatchEvent(new window.CustomEvent<ConnectorsSettingsTarget>(CONNECTORS_SETTINGS_LINK_EVENT, { detail: { tab: 'connectors', providerId: null } }));
}

/** The status line under "Personal agent": Not set up, Off, or what it watches. */
export function personalAgentStatusLine(status: PersonalAgentStatus | null) {
  if (!status) return '';
  if (!status.connected) return 'Not set up';
  if (!status.proactive) return 'Off';
  const count = status.sources.length;
  return `Watching ${count} ${count === 1 ? 'source' : 'sources'}`;
}

function minutesAgo(at: string | null) {
  const ms = at ? Date.parse(at) : Number.NaN;
  if (!Number.isFinite(ms)) return null;
  const minutes = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (minutes < 1) return 'checked just now';
  if (minutes < 60) return `checked ${minutes} min ago`;
  return `checked at ${formatDesktopLastActiveLabel(ms)}`;
}

/** The status line under the title: Off, or what it watches and when it last looked. */
export function personalAgentPageStatus(status: PersonalAgentStatus) {
  if (!status.proactive) return 'Off';
  const count = status.sources.length;
  const checked = minutesAgo(status.checkedAt);
  return [`Watching ${count} ${count === 1 ? 'source' : 'sources'}`, checked].filter(Boolean).join(' · ');
}
