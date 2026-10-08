import {
  connectorCatalog,
  connectorDefinition,
  connectScopes,
  type ConnectorAgent,
  type ConnectorAuditEntry,
  type ConnectorProviderId,
  type ConnectorState,
} from './connectorsModel';
import type { ConnectorsClient } from './connectorsClient';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function ago(now: number, ms: number): string {
  return new Date(now - ms).toISOString();
}

export function readScopeIds(providerId: ConnectorProviderId): string[] {
  return connectorDefinition(providerId).readScopes.map((scope) => scope.id);
}

function actScopeIds(providerId: ConnectorProviderId): string[] {
  return connectorDefinition(providerId).actScopes.map((scope) => scope.id);
}

export function emptyState(providerId: ConnectorProviderId): ConnectorState {
  return {
    providerId,
    status: 'not_connected',
    connectedAt: null,
    grantedScopeIds: [],
    actEnabled: false,
    agentIds: [],
    lastEventAt: null,
  };
}

export type PreviewConnectorsClientOptions = {
  /** Simulated network latency in milliseconds. */
  latencyMs?: number;
  now?: () => number;
};

/**
 * In-memory connectors client with sample data. It never holds anything that
 * looks like a credential; it only models what the settings page shows.
 */
export function createPreviewConnectorsClient(options: PreviewConnectorsClientOptions = {}): ConnectorsClient {
  const latencyMs = options.latencyMs ?? 400;
  const now = options.now ?? Date.now;
  const seededAt = now();

  const agents: ConnectorAgent[] = [
    { agentId: 'agent-default', name: 'My Kordi', isDefault: true },
    { agentId: 'agent-research', name: 'Research', isDefault: false },
    { agentId: 'agent-ops', name: 'Ops', isDefault: false },
  ];

  const states = new Map<ConnectorProviderId, ConnectorState>(
    connectorCatalog.map((definition) => [definition.providerId, emptyState(definition.providerId)]),
  );
  states.set('google_calendar', {
    providerId: 'google_calendar',
    status: 'connected',
    connectedAt: ago(seededAt, 12 * DAY),
    grantedScopeIds: [...readScopeIds('google_calendar'), ...actScopeIds('google_calendar')],
    actEnabled: true,
    agentIds: ['agent-default'],
    lastEventAt: ago(seededAt, 20 * MINUTE),
  });
  states.set('github', {
    providerId: 'github',
    status: 'connected',
    connectedAt: ago(seededAt, 30 * DAY),
    grantedScopeIds: readScopeIds('github'),
    actEnabled: false,
    agentIds: ['agent-default', 'agent-research'],
    lastEventAt: ago(seededAt, 4 * MINUTE),
  });
  states.set('slack', {
    providerId: 'slack',
    status: 'needs_reauth',
    connectedAt: ago(seededAt, 60 * DAY),
    grantedScopeIds: readScopeIds('slack'),
    actEnabled: false,
    agentIds: ['agent-default'],
    lastEventAt: ago(seededAt, 3 * DAY),
  });
  states.set('mac_calendar', {
    providerId: 'mac_calendar',
    status: 'connected',
    connectedAt: ago(seededAt, 5 * DAY),
    grantedScopeIds: readScopeIds('mac_calendar'),
    actEnabled: false,
    agentIds: agents.map((agent) => agent.agentId),
    lastEventAt: ago(seededAt, 2 * HOUR),
  });
  states.set('mac_notification_center', {
    ...emptyState('mac_notification_center'),
    status: 'permission_missing',
  });

  let audit: ConnectorAuditEntry[] = [
    {
      id: 'audit-1',
      providerId: 'google_calendar',
      at: ago(seededAt, 18 * MINUTE),
      agentName: 'My Kordi',
      tool: 'calendar.list_events',
      group: 'read',
      outcome: 'completed',
      summary: 'Read events for today and tomorrow.',
    },
    {
      id: 'audit-2',
      providerId: 'google_calendar',
      at: ago(seededAt, 2 * HOUR),
      agentName: 'My Kordi',
      tool: 'calendar.reply_invitation',
      group: 'act',
      outcome: 'approved',
      summary: 'Accepted "Design review" on Thursday after you approved it.',
    },
    {
      id: 'audit-3',
      providerId: 'google_calendar',
      at: ago(seededAt, 6 * HOUR),
      agentName: 'My Kordi',
      tool: 'calendar.create_event',
      group: 'act',
      outcome: 'blocked_background',
      summary: 'Background digest asked for calendar.create_event and was given read tools only.',
    },
    {
      id: 'audit-4',
      providerId: 'google_calendar',
      at: ago(seededAt, DAY + 3 * HOUR),
      agentName: 'My Kordi',
      tool: 'calendar.create_event',
      group: 'act',
      outcome: 'denied',
      summary: 'Proposed a 30 minute focus block on Friday. You declined.',
    },
    {
      id: 'audit-5',
      providerId: 'github',
      at: ago(seededAt, 5 * MINUTE),
      agentName: 'Research',
      tool: 'github.list_notifications',
      group: 'read',
      outcome: 'completed',
      summary: 'Read 7 unread notifications.',
    },
    {
      id: 'audit-6',
      providerId: 'github',
      at: ago(seededAt, 3 * HOUR),
      agentName: 'My Kordi',
      tool: 'github.get_pull_request',
      group: 'read',
      outcome: 'completed',
      summary: 'Checked review state on a pull request you follow.',
    },
    {
      id: 'audit-7',
      providerId: 'github',
      at: ago(seededAt, 2 * DAY),
      agentName: 'My Kordi',
      tool: 'github.create_comment',
      group: 'act',
      outcome: 'blocked_background',
      summary: 'Scheduled task asked for github.create_comment and was given read tools only.',
    },
  ];

  const wait = () => new Promise<void>((resolve) => {
    if (latencyMs <= 0) resolve();
    else setTimeout(resolve, latencyMs);
  });

  const current = (providerId: ConnectorProviderId): ConnectorState => {
    const state = states.get(providerId);
    if (!state) throw new Error('This connector is not available.');
    return state;
  };

  const update = (providerId: ConnectorProviderId, patch: Partial<ConnectorState>): ConnectorState => {
    const next = { ...current(providerId), ...patch, providerId };
    states.set(providerId, next);
    return { ...next, grantedScopeIds: [...next.grantedScopeIds], agentIds: [...next.agentIds] };
  };

  const copy = (state: ConnectorState): ConnectorState => (
    { ...state, grantedScopeIds: [...state.grantedScopeIds], agentIds: [...state.agentIds] }
  );

  const defaultAgentIds = () => agents.filter((agent) => agent.isDefault).map((agent) => agent.agentId);

  return {
    async list() {
      await wait();
      return {
        states: connectorCatalog.map((definition) => copy(current(definition.providerId))),
        agents: agents.map((agent) => ({ ...agent })),
      };
    },
    async connect(providerId, input) {
      await wait();
      const definition = connectorDefinition(providerId);
      if (definition.availability !== 'available') throw new Error(`${definition.name} is not yet available.`);
      // A service connect grants read and act together and turns acting on.
      const allowed = new Set(connectScopes(definition).map((scope) => scope.id));
      const scopeIds = input.scopeIds.filter((id) => allowed.has(id));
      const previous = current(providerId);
      if (definition.requiresFullDiskAccess) {
        // Full Disk Access cannot be requested in-app; the person grants it in System Settings.
        return update(providerId, { ...emptyState(providerId), status: 'permission_missing' });
      }
      const granted = scopeIds.length > 0 ? scopeIds : [...allowed];
      return update(providerId, {
        status: 'connected',
        connectedAt: new Date(now()).toISOString(),
        grantedScopeIds: granted,
        actEnabled: definition.kind === 'service' && actScopeIds(providerId).some((id) => granted.includes(id)),
        agentIds: previous.agentIds.length > 0 ? previous.agentIds : defaultAgentIds(),
      });
    },
    async grantAct(providerId) {
      await wait();
      const state = current(providerId);
      if (state.status !== 'connected') throw new Error('Connect first, then let your agent act here.');
      const granted = new Set([...state.grantedScopeIds, ...actScopeIds(providerId)]);
      return update(providerId, { grantedScopeIds: [...granted], actEnabled: true });
    },
    async setActEnabled(providerId, enabled) {
      await wait();
      const state = current(providerId);
      if (enabled) {
        const definition = connectorDefinition(providerId);
        const missing = definition.actScopes.some((scope) => !state.grantedScopeIds.includes(scope.id));
        if (definition.kind === 'service' && missing) {
          throw new Error(`Grant act access to ${definition.name} first.`);
        }
        if (definition.kind === 'mac_local' && missing) {
          const granted = new Set([...state.grantedScopeIds, ...actScopeIds(providerId)]);
          return update(providerId, { grantedScopeIds: [...granted], actEnabled: true });
        }
      }
      return update(providerId, { actEnabled: enabled });
    },
    async setAgentGrant(providerId, agentId, granted) {
      await wait();
      const state = current(providerId);
      const ids = new Set(state.agentIds);
      if (granted) ids.add(agentId);
      else ids.delete(agentId);
      return update(providerId, { agentIds: agents.map((agent) => agent.agentId).filter((id) => ids.has(id)) });
    },
    async disconnect(providerId) {
      await wait();
      states.set(providerId, emptyState(providerId));
      audit = audit.filter((entry) => entry.providerId !== providerId);
    },
    async auditLog(providerId) {
      await wait();
      return audit
        .filter((entry) => entry.providerId === providerId)
        .sort((a, b) => b.at.localeCompare(a.at))
        .map((entry) => ({ ...entry }));
    },
    async recheckPermission(providerId) {
      await wait();
      const state = current(providerId);
      if (providerId === 'mac_notification_center' && state.status === 'permission_missing') {
        // Simulates the person granting Full Disk Access in System Settings.
        return update(providerId, {
          status: 'connected',
          connectedAt: new Date(now()).toISOString(),
          grantedScopeIds: readScopeIds(providerId),
          agentIds: state.agentIds.length > 0 ? state.agentIds : defaultAgentIds(),
        });
      }
      return copy(state);
    },
  };
}
