// Server-backed connectors client for accounts whose server reports
// `connectorsVersion`. Service rows only; the Mac-local rows are layered on
// top by `createDesktopMacLocalConnectorsClient`.

import { normalizeCloudAgentDefinition } from '@/features/cloud/cloudAgents';
import {
  cloudConnectorErrorCode,
  parseConnectorCallbackFragment,
  type CloudConnectorAuditEntry,
  type CloudConnectorSummary,
  type CloudConnectorToolGroup,
  type CloudConnectorsHttpClient,
} from '@/features/cloud/cloudConnectorsClient';
import { loadSession } from '@/features/cloud/session';

import type { ConnectorsClient } from './connectorsClient';
import { ConnectorGoneError } from './connectorsErrors';
import {
  connectorCatalog,
  connectorDefinition,
  hasGrantedActScopes,
  type ConnectorAgent,
  type ConnectorAuditEntry,
  type ConnectorAuditOutcome,
  type ConnectorProviderId,
  type ConnectorState,
  type ConnectorStatus,
} from './connectorsModel';
import {
  abortable,
  abortableDelay,
  CONNECTOR_OAUTH_TIMEOUT_MS,
  connectorCanceledError,
  desktopConnectorOAuthHandoff,
  withTimeout,
  type ConnectorOAuthHandoff,
} from './connectorsOAuthHandoff';

function readScopeIds(providerId: ConnectorProviderId): string[] {
  return connectorDefinition(providerId).readScopes.map((scope) => scope.id);
}

function actScopeIds(providerId: ConnectorProviderId): string[] {
  return connectorDefinition(providerId).actScopes.map((scope) => scope.id);
}

function emptyState(providerId: ConnectorProviderId): ConnectorState {
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

export type CloudConnectorsApi = Pick<
  CloudConnectorsHttpClient,
  'list' | 'listAgents' | 'startOAuth' | 'completeOAuth' | 'setAct' | 'setAgents' | 'audit' | 'delete'
>;

export {
  CONNECTOR_OAUTH_TIMEOUT_MS,
  desktopConnectorOAuthHandoff,
  type ConnectorOAuthCallback,
  type ConnectorOAuthHandoff,
} from './connectorsOAuthHandoff';

/** Consecutive failed polls tolerated before the polling path gives up. */
const POLL_RETRIES = 3;

export type CloudConnectorsClientOptions = {
  accountId: string;
  http: CloudConnectorsApi;
  /** Name shown for the account's built-in agent. */
  defaultAgentName?: string;
  loadToken?: () => Promise<string>;
  oauth?: ConnectorOAuthHandoff;
  oauthTimeoutMs?: number;
  /** Poll interval when the shell has no callback listener. */
  pollIntervalMs?: number;
};

const connectorProviderIds = new Set<string>(connectorCatalog.map((definition) => definition.providerId));

function isConnectorProviderId(value: string): value is ConnectorProviderId {
  return connectorProviderIds.has(value);
}

/** The account's built-in agent id, matching the server's `default_agent_id`. */
export function defaultConnectorAgentId(accountId: string): string {
  return `cloud-agent:${accountId.trim()}`;
}

/**
 * Coarse fallback for servers that do not send `grantedScopeIds`: any granted
 * provider scope in a group counts as the catalog's whole read or act group.
 */
function coarseGrantedScopeIds(providerId: ConnectorProviderId, summary: CloudConnectorSummary): string[] {
  return [
    ...(summary.readScopes.length > 0 ? readScopeIds(providerId) : []),
    ...(summary.actScopes.length > 0 ? actScopeIds(providerId) : []),
  ];
}

/** Maps a server summary to the panel state. */
export function connectorStateFromSummary(
  providerId: ConnectorProviderId,
  summary: CloudConnectorSummary | undefined,
): ConnectorState {
  if (!summary || summary.status === 'revoked') return emptyState(providerId);
  const status: ConnectorStatus = summary.status === 'needs_reauth' ? 'needs_reauth' : 'connected';
  const grantedScopeIds = Array.isArray(summary.grantedScopeIds)
    ? summary.grantedScopeIds.filter((id): id is string => typeof id === 'string')
    : coarseGrantedScopeIds(providerId, summary);
  return {
    providerId,
    status,
    connectedAt: summary.createdAt || null,
    grantedScopeIds,
    actEnabled: summary.actEnabled,
    agentIds: [...summary.agentIds],
    lastEventAt: typeof summary.lastEventAt === 'string' && summary.lastEventAt ? summary.lastEventAt : null,
  };
}

const auditOutcomes = new Set<ConnectorAuditOutcome>(['completed', 'approved', 'denied', 'blocked_background', 'failed']);

export function connectorAuditEntryFromCloud(
  providerId: ConnectorProviderId,
  entry: CloudConnectorAuditEntry,
  agents: ConnectorAgent[],
): ConnectorAuditEntry {
  const agentName = entry.agentId
    ? agents.find((agent) => agent.agentId === entry.agentId)?.name ?? entry.agentId
    : 'You';
  const outcome = auditOutcomes.has(entry.outcome as ConnectorAuditOutcome)
    ? entry.outcome as ConnectorAuditOutcome
    : 'failed';
  return {
    id: entry.auditId,
    providerId,
    at: entry.createdAt,
    agentName,
    tool: entry.tool,
    group: entry.toolGroup === 'act' ? 'act' : 'read',
    outcome,
    summary: entry.summary,
  };
}

function connectorOAuthTimeoutMessage(providerId: ConnectorProviderId): string {
  return `Connecting ${connectorDefinition(providerId).name} timed out after 10 minutes. Try again.`;
}

export function createCloudConnectorsClient(options: CloudConnectorsClientOptions): ConnectorsClient {
  const { accountId, http } = options;
  const oauth = options.oauth ?? desktopConnectorOAuthHandoff;
  const oauthTimeoutMs = options.oauthTimeoutMs ?? CONNECTOR_OAUTH_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? 3_000;
  const defaultAgent: ConnectorAgent = {
    agentId: defaultConnectorAgentId(accountId),
    name: options.defaultAgentName?.trim() || 'My Kordi',
    isDefault: true,
  };
  let agents: ConnectorAgent[] = [defaultAgent];
  // True when `agents` is the server's full list, so stale grant ids can be dropped.
  let agentsComplete = false;
  let summaries = new Map<ConnectorProviderId, CloudConnectorSummary>();

  const loadToken = options.loadToken ?? (async () => {
    const session = await loadSession();
    if (!session?.token || session.accountId !== accountId) {
      throw new Error('The active account session is unavailable. Sign in again.');
    }
    return session.token;
  });

  const loadAgents = async (token: string, listed?: ConnectorAgent[]): Promise<{ agents: ConnectorAgent[]; complete: boolean }> => {
    if (listed && listed.length > 0) {
      return { agents: listed.map((agent) => ({ agentId: agent.agentId, name: agent.name, isDefault: Boolean(agent.isDefault) })), complete: true };
    }
    try {
      const body = await http.listAgents(token);
      const defined = (Array.isArray(body?.agents) ? body.agents : [])
        .flatMap((value) => {
          const agent = normalizeCloudAgentDefinition(value);
          return agent && agent.status === 'active' ? [{ agentId: agent.agentId, name: agent.name, isDefault: false }] : [];
        });
      return { agents: [defaultAgent, ...defined], complete: true };
    } catch {
      // Agent grants still work for the built-in agent when the list fails.
      return { agents: [defaultAgent], complete: false };
    }
  };

  const refresh = async (token: string) => {
    const response = await http.list(token);
    const next = new Map<ConnectorProviderId, CloudConnectorSummary>();
    for (const summary of response.connectors ?? []) {
      if (!isConnectorProviderId(summary.provider) || summary.status === 'revoked') continue;
      next.set(summary.provider, summary);
    }
    summaries = next;
    const listedAgents = response.agents?.map((agent) => ({
      agentId: agent.agentId,
      name: agent.name,
      isDefault: Boolean(agent.isDefault),
    }));
    const loaded = await loadAgents(token, listedAgents);
    agents = loaded.agents;
    agentsComplete = loaded.complete;
    return next;
  };

  const stateFor = (providerId: ConnectorProviderId) => connectorStateFromSummary(providerId, summaries.get(providerId));

  const remember = (summary: CloudConnectorSummary): ConnectorState | null => {
    if (!isConnectorProviderId(summary.provider)) return null;
    summaries.set(summary.provider, summary);
    return stateFor(summary.provider);
  };

  const connectorFor = async (token: string, providerId: ConnectorProviderId): Promise<CloudConnectorSummary> => {
    const known = summaries.get(providerId) ?? (await refresh(token)).get(providerId);
    if (!known) throw new Error(`${connectorDefinition(providerId).name} is not connected.`);
    return known;
  };

  /**
   * Runs a call against the provider's connector. When the server no longer
   * has it, the cached summary is dropped, the list is reloaded, and the error
   * says so instead of showing a bare 404.
   */
  const withConnector = async <T,>(
    providerId: ConnectorProviderId,
    run: (token: string, connector: CloudConnectorSummary) => Promise<T>,
  ): Promise<T> => {
    const token = await loadToken();
    const connector = await connectorFor(token, providerId);
    try {
      return await run(token, connector);
    } catch (caught) {
      if (cloudConnectorErrorCode(caught) !== 'connector_not_found') throw caught;
      summaries.delete(providerId);
      await refresh(token).catch(() => undefined);
      throw new ConnectorGoneError(`${connectorDefinition(providerId).name} is no longer connected.`);
    }
  };

  const grantSucceeded = (providerId: ConnectorProviderId, grant: CloudConnectorToolGroup, state: ConnectorState) => (
    state.status === 'connected'
    && (grant === 'read' || hasGrantedActScopes(connectorDefinition(providerId), state))
  );

  const waitForPolledGrant = async (
    token: string,
    providerId: ConnectorProviderId,
    grant: CloudConnectorToolGroup,
    previousUpdatedAt: string | null,
    signal: AbortSignal | undefined,
  ) => {
    const name = connectorDefinition(providerId).name;
    const deadline = Date.now() + oauthTimeoutMs;
    let failures = 0;
    while (Date.now() < deadline) {
      await abortableDelay(pollIntervalMs, signal, name);
      let listed: Map<ConnectorProviderId, CloudConnectorSummary>;
      try {
        listed = await abortable(refresh(token), signal, name);
        failures = 0;
      } catch (caught) {
        if (signal?.aborted) throw connectorCanceledError(name);
        failures += 1;
        if (failures > POLL_RETRIES) throw caught;
        continue;
      }
      const summary = listed.get(providerId);
      if (
        summary
        && summary.updatedAt !== previousUpdatedAt
        && grantSucceeded(providerId, grant, connectorStateFromSummary(providerId, summary))
      ) return;
    }
    throw new Error(connectorOAuthTimeoutMessage(providerId));
  };

  const runOAuth = async (
    providerId: ConnectorProviderId,
    grant: CloudConnectorToolGroup,
    signal: AbortSignal | undefined,
  ): Promise<ConnectorState> => {
    const definition = connectorDefinition(providerId);
    if (definition.kind !== 'service') throw new Error('This connector is not a service connector.');
    if (definition.availability !== 'available') throw new Error(`${definition.name} is not yet available.`);
    if (signal?.aborted) throw connectorCanceledError(definition.name);
    const token = await abortable(loadToken(), signal, definition.name);
    const previousUpdatedAt = summaries.get(providerId)?.updatedAt ?? null;
    const callback = await oauth.prepare();
    const onAbort = () => { void callback?.cancel(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    const timeoutMessage = connectorOAuthTimeoutMessage(providerId);
    try {
      const { authUrl } = await abortable(http.startOAuth(token, providerId, {
        grant,
        ...(callback ? { redirectAfter: callback.redirectUrl } : {}),
      }), signal, definition.name);
      if (await oauth.open(authUrl) === false) {
        throw new Error(`Allow pop-ups for Kordi to connect ${definition.name}.`);
      }
      if (callback) {
        let fragment: string;
        try {
          fragment = await abortable(withTimeout(callback.wait(oauthTimeoutMs), oauthTimeoutMs, timeoutMessage, signal), signal, definition.name);
        } catch (caught) {
          if (signal?.aborted) throw connectorCanceledError(definition.name);
          const message = caught instanceof Error ? caught.message : String(caught);
          throw new Error(/timed out/i.test(message) ? timeoutMessage : message);
        }
        const parsed = parseConnectorCallbackFragment(fragment);
        if (!parsed) throw new Error(`${definition.name} did not return a connection result. Try again.`);
        if (parsed.kind === 'error') throw new Error(parsed.message);
        if (parsed.result.provider !== providerId) {
          throw new Error(`The connection finished for a different service. Try ${definition.name} again.`);
        }
        if (parsed.kind === 'pending') {
          // The connector is only connected once the client finishes the grant.
          const completed = await abortable(http.completeOAuth(token, parsed.result.completionCode), signal, definition.name);
          remember(completed.connector);
        }
      } else {
        await waitForPolledGrant(token, providerId, grant, previousUpdatedAt, signal);
      }
      await abortable(refresh(token), signal, definition.name);
      const state = stateFor(providerId);
      if (!grantSucceeded(providerId, grant, state)) {
        throw new Error(grant === 'act'
          ? `${definition.name} did not grant act access.`
          : `${definition.name} did not finish connecting. Try again.`);
      }
      return state;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (callback) await callback.cancel();
    }
  };

  return {
    async list() {
      const token = await loadToken();
      await refresh(token);
      return {
        states: connectorCatalog.map((definition) => stateFor(definition.providerId)),
        agents: agents.map((agent) => ({ ...agent })),
      };
    },
    connect(providerId, input) {
      return runOAuth(providerId, 'read', input.signal);
    },
    grantAct(providerId, grantOptions) {
      return runOAuth(providerId, 'act', grantOptions?.signal);
    },
    setActEnabled(providerId, enabled) {
      return withConnector(providerId, async (token, connector) => {
        const response = await http.setAct(token, connector.connectorId, enabled);
        return remember(response.connector) ?? stateFor(providerId);
      });
    },
    setAgentGrant(providerId, agentId, granted) {
      return withConnector(providerId, async (token, connector) => {
        // Drop grants to agents that no longer exist (archived or deleted) so
        // one stale id does not make the server reject every change.
        const known = new Set(agents.map((agent) => agent.agentId));
        const ids = new Set(agentsComplete ? connector.agentIds.filter((id) => known.has(id)) : connector.agentIds);
        if (granted) ids.add(agentId);
        else ids.delete(agentId);
        const response = await http.setAgents(token, connector.connectorId, [...ids]);
        return remember(response.connector) ?? stateFor(providerId);
      });
    },
    async disconnect(providerId) {
      await withConnector(providerId, (token, connector) => http.delete(token, connector.connectorId));
      summaries.delete(providerId);
    },
    async auditLog(providerId) {
      const token = await loadToken();
      if (!summaries.has(providerId) && !(await refresh(token)).has(providerId)) return [];
      return withConnector(providerId, async (innerToken, connector) => {
        const response = await http.audit(innerToken, connector.connectorId, { limit: 50 });
        return (response.entries ?? []).map((entry) => connectorAuditEntryFromCloud(providerId, entry, agents));
      });
    },
    async recheckPermission(providerId) {
      const token = await loadToken();
      await refresh(token);
      return stateFor(providerId);
    },
  };
}
