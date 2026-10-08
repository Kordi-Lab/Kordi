import {
  connectorCatalog,
  type ConnectorAgent,
  type ConnectorProviderId,
  type ConnectorState,
  type ConnectorStatus,
} from './connectorsModel';
import type { ConnectorsClient } from './connectorsClient';
import { emptyState, readScopeIds } from './connectorsPreviewClient';

/** Source keys used by the `desktop_mac_local_connectors_*` Tauri commands. */
export type MacLocalSource = 'calendar' | 'contacts' | 'notification_center';
export type MacLocalPermission =
  | 'granted'
  | 'denied'
  | 'not_determined'
  | 'full_disk_access_missing'
  | 'unavailable';
export type MacLocalSourceState = { enabled: boolean; permission: MacLocalPermission };
export type MacLocalConnectorsState = Record<MacLocalSource, MacLocalSourceState>;
export type DesktopInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const macLocalSources: Partial<Record<ConnectorProviderId, MacLocalSource>> = {
  mac_calendar: 'calendar',
  mac_contacts: 'contacts',
  mac_notification_center: 'notification_center',
};

export function macLocalSourceFor(providerId: ConnectorProviderId): MacLocalSource | null {
  return macLocalSources[providerId] ?? null;
}

export function macLocalConnectorStatus(state: MacLocalSourceState): ConnectorStatus {
  if (state.enabled && state.permission === 'granted') return 'connected';
  if (state.permission === 'denied' || state.permission === 'full_disk_access_missing') return 'permission_missing';
  return 'not_connected';
}

/**
 * Maps one Mac-local source to the panel's connector state. Mac-local
 * connectors are read-only until the act tools ship, and they apply to every
 * agent that runs on this Mac.
 */
export function macLocalConnectorState(
  providerId: ConnectorProviderId,
  source: MacLocalSourceState,
  agents: ConnectorAgent[],
): ConnectorState {
  const status = macLocalConnectorStatus(source);
  return {
    ...emptyState(providerId),
    status,
    grantedScopeIds: status === 'connected' ? readScopeIds(providerId) : [],
    agentIds: status === 'connected' ? agents.map((agent) => agent.agentId) : [],
  };
}

/**
 * Backs the three Mac-local rows with the desktop commands and delegates the
 * service rows to `services` (the preview client until the server client
 * exists). Without `services`, service rows stay not connected.
 */
export function createDesktopMacLocalConnectorsClient(
  invoke: DesktopInvoke,
  services: ConnectorsClient | null,
): ConnectorsClient {
  let agents: ConnectorAgent[] = [];

  const sourceFor = (providerId: ConnectorProviderId): MacLocalSource => {
    const source = macLocalSourceFor(providerId);
    if (!source) throw new Error('This connector is not on this Mac.');
    return source;
  };
  const servicesClient = (): ConnectorsClient => {
    if (!services) throw new Error('Service connectors are not available yet.');
    return services;
  };
  const stateFrom = (providerId: ConnectorProviderId, all: MacLocalConnectorsState) => (
    macLocalConnectorState(providerId, all[sourceFor(providerId)], agents)
  );

  return {
    async list() {
      const [macLocal, base] = await Promise.all([
        invoke<MacLocalConnectorsState>('desktop_mac_local_connectors_state'),
        services ? services.list() : Promise.resolve(null),
      ]);
      agents = base?.agents ?? [];
      const baseStates = new Map(base?.states.map((state) => [state.providerId, state]) ?? []);
      return {
        states: connectorCatalog.map((definition) => (
          macLocalSourceFor(definition.providerId)
            ? stateFrom(definition.providerId, macLocal)
            : baseStates.get(definition.providerId) ?? emptyState(definition.providerId)
        )),
        agents: agents.map((agent) => ({ ...agent })),
      };
    },
    async connect(providerId, input) {
      const source = macLocalSourceFor(providerId);
      if (!source) return servicesClient().connect(providerId, input);
      try {
        const all = await invoke<MacLocalConnectorsState>('desktop_mac_local_connectors_set_enabled', { source, enabled: true });
        return stateFrom(providerId, all);
      } catch (error) {
        // Full Disk Access cannot be requested in-app; show what is missing instead of failing.
        const all = await invoke<MacLocalConnectorsState>('desktop_mac_local_connectors_recheck');
        if (all[source].permission === 'full_disk_access_missing') return stateFrom(providerId, all);
        throw error;
      }
    },
    async grantAct(providerId, options) {
      if (macLocalSourceFor(providerId)) throw new Error('Acting on this Mac is not available yet.');
      return servicesClient().grantAct(providerId, options);
    },
    async setActEnabled(providerId, enabled) {
      if (macLocalSourceFor(providerId)) {
        if (enabled) throw new Error('Acting on this Mac is not available yet.');
        const all = await invoke<MacLocalConnectorsState>('desktop_mac_local_connectors_state');
        return stateFrom(providerId, all);
      }
      return servicesClient().setActEnabled(providerId, enabled);
    },
    async setAgentGrant(providerId, agentId, granted) {
      if (macLocalSourceFor(providerId)) throw new Error('Mac connectors apply to every agent on this Mac.');
      return servicesClient().setAgentGrant(providerId, agentId, granted);
    },
    async disconnect(providerId) {
      const source = macLocalSourceFor(providerId);
      if (!source) return servicesClient().disconnect(providerId);
      await invoke<MacLocalConnectorsState>('desktop_mac_local_connectors_set_enabled', { source, enabled: false });
    },
    async auditLog(providerId) {
      // Mac-local reads are not audited yet; the audit table lands with the consent work.
      if (macLocalSourceFor(providerId)) return [];
      return servicesClient().auditLog(providerId);
    },
    async recheckPermission(providerId) {
      if (!macLocalSourceFor(providerId)) return servicesClient().recheckPermission(providerId);
      const all = await invoke<MacLocalConnectorsState>('desktop_mac_local_connectors_recheck');
      return stateFrom(providerId, all);
    },
  };
}
