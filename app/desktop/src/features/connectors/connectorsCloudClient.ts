// Server-backed connectors client for accounts whose server reports
// `connectorsVersion`. Service rows only; the Mac-local rows are layered on
// top by `createDesktopMacLocalConnectorsClient`.

import { normalizeCloudAgentDefinition } from '@/features/cloud/cloudAgents';
import {
  parseConnectorCallbackFragment,
  type CloudConnectorAuditEntry,
  type CloudConnectorSummary,
  type CloudConnectorToolGroup,
  type CloudConnectorsHttpClient,
} from '@/features/cloud/cloudConnectorsClient';
import { loadSession } from '@/features/cloud/session';

import type { ConnectorsClient } from './connectorsClient';
import {
  connectorCatalog,
  connectorDefinition,
  type ConnectorAgent,
  type ConnectorAuditEntry,
  type ConnectorAuditOutcome,
  type ConnectorProviderId,
  type ConnectorState,
  type ConnectorStatus,
} from './connectorsModel';

const MINUTE = 60_000;

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
  'list' | 'listAgents' | 'startOAuth' | 'setAct' | 'setAgents' | 'audit' | 'delete'
>;

/** A local callback target the server redirects to after the provider grant. */
export type ConnectorOAuthCallback = {
  redirectUrl: string;
  /** Resolves with the callback fragment, for example `#kordi_connector=...`. */
  wait(timeoutMs: number): Promise<string>;
  cancel(): Promise<void>;
};

export type ConnectorOAuthHandoff = {
  /** Null when this shell cannot receive the callback; the client then polls. */
  prepare(): Promise<ConnectorOAuthCallback | null>;
  open(url: string): Promise<unknown>;
};

/**
 * Same handoff as cloud sign-in: a one-use loopback listener in the desktop
 * shell receives the redirect, and the provider page opens in the system
 * browser.
 */
export const desktopConnectorOAuthHandoff: ConnectorOAuthHandoff = {
  async prepare() {
    const desktop = await import('@/lib/desktop');
    const loopback = await desktop.prepareDesktopCloudOAuthLoopback();
    if (!loopback) return null;
    return {
      redirectUrl: loopback.redirectUrl,
      wait: (timeoutMs) => desktop.waitForDesktopCloudOAuthLoopback(loopback.requestId, timeoutMs),
      cancel: async () => {
        await desktop.invokeDesktop<void>('cloud_oauth_loopback_cancel', { requestId: loopback.requestId })
          .catch(() => undefined);
      },
    };
  },
  async open(url) {
    const desktop = await import('@/lib/desktop');
    return desktop.openDesktopExternalUrl(url);
  },
};

export const CONNECTOR_OAUTH_TIMEOUT_MS = 10 * MINUTE;

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
 * Maps a server summary to the panel state. Server scopes are provider scope
 * strings, so granted scopes are shown as the catalog's read and act groups.
 */
export function connectorStateFromSummary(
  providerId: ConnectorProviderId,
  summary: CloudConnectorSummary | undefined,
): ConnectorState {
  if (!summary || summary.status === 'revoked') return emptyState(providerId);
  const status: ConnectorStatus = summary.status === 'needs_reauth' ? 'needs_reauth' : 'connected';
  const hasRead = summary.readScopes.length > 0;
  const hasAct = summary.actScopes.length > 0;
  return {
    providerId,
    status,
    connectedAt: summary.createdAt || null,
    grantedScopeIds: [
      ...(hasRead ? readScopeIds(providerId) : []),
      ...(hasAct ? actScopeIds(providerId) : []),
    ],
    actEnabled: summary.actEnabled,
    agentIds: [...summary.agentIds],
    lastEventAt: null,
  };
}

const auditOutcomes = new Set<ConnectorAuditOutcome>(['completed', 'approved', 'denied', 'blocked_background', 'failed']);

export function connectorAuditEntryFromCloud(
  providerId: ConnectorProviderId,
  entry: CloudConnectorAuditEntry,
  agents: ConnectorAgent[],
): ConnectorAuditEntry {
  const agentName = entry.agentId
    ? agents.find((agent) => agent.agentId === entry.agentId)?.name ?? 'Agent'
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

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    operation.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); },
    );
  });
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
  let summaries = new Map<ConnectorProviderId, CloudConnectorSummary>();

  const loadToken = options.loadToken ?? (async () => {
    const session = await loadSession();
    if (!session?.token || session.accountId !== accountId) {
      throw new Error('The active account session is unavailable. Sign in again.');
    }
    return session.token;
  });

  const loadAgents = async (token: string, listed?: ConnectorAgent[]): Promise<ConnectorAgent[]> => {
    if (listed && listed.length > 0) {
      return listed.map((agent) => ({ agentId: agent.agentId, name: agent.name, isDefault: Boolean(agent.isDefault) }));
    }
    try {
      const body = await http.listAgents(token);
      const defined = (Array.isArray(body?.agents) ? body.agents : [])
        .flatMap((value) => {
          const agent = normalizeCloudAgentDefinition(value);
          return agent && agent.status === 'active' ? [{ agentId: agent.agentId, name: agent.name, isDefault: false }] : [];
        });
      return [defaultAgent, ...defined];
    } catch {
      // Agent grants still work for the built-in agent when the list fails.
      return [defaultAgent];
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
    agents = await loadAgents(token, listedAgents);
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

  const waitForPolledGrant = async (
    token: string,
    providerId: ConnectorProviderId,
    grant: CloudConnectorToolGroup,
    previousUpdatedAt: string | null,
  ) => {
    const deadline = Date.now() + oauthTimeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      const summary = (await refresh(token)).get(providerId);
      if (
        summary
        && summary.status === 'connected'
        && summary.updatedAt !== previousUpdatedAt
        && (grant === 'read' || summary.actScopes.length > 0)
      ) return;
    }
    throw new Error(connectorOAuthTimeoutMessage(providerId));
  };

  const runOAuth = async (providerId: ConnectorProviderId, grant: CloudConnectorToolGroup): Promise<ConnectorState> => {
    const definition = connectorDefinition(providerId);
    if (definition.kind !== 'service') throw new Error('This connector is not a service connector.');
    if (definition.availability !== 'available') throw new Error(`${definition.name} is not yet available.`);
    const token = await loadToken();
    const previousUpdatedAt = summaries.get(providerId)?.updatedAt ?? null;
    const callback = await oauth.prepare();
    const timeoutMessage = connectorOAuthTimeoutMessage(providerId);
    try {
      const { authUrl } = await http.startOAuth(token, providerId, {
        grant,
        ...(callback ? { redirectAfter: callback.redirectUrl } : {}),
      });
      await oauth.open(authUrl);
      if (callback) {
        let fragment: string;
        try {
          fragment = await withTimeout(callback.wait(oauthTimeoutMs), oauthTimeoutMs, timeoutMessage);
        } catch (caught) {
          const message = caught instanceof Error ? caught.message : String(caught);
          throw new Error(/timed out/i.test(message) ? timeoutMessage : message);
        }
        const parsed = parseConnectorCallbackFragment(fragment);
        if (!parsed) throw new Error(`${definition.name} did not return a connection result. Try again.`);
        if (parsed.kind === 'error') throw new Error(parsed.message);
        if (parsed.result.provider !== providerId) {
          throw new Error(`The connection finished for a different service. Try ${definition.name} again.`);
        }
      } else {
        await waitForPolledGrant(token, providerId, grant, previousUpdatedAt);
      }
      await refresh(token);
      return stateFor(providerId);
    } finally {
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
    connect(providerId) {
      return runOAuth(providerId, 'read');
    },
    grantAct(providerId) {
      return runOAuth(providerId, 'act');
    },
    async setActEnabled(providerId, enabled) {
      const token = await loadToken();
      const connector = await connectorFor(token, providerId);
      const response = await http.setAct(token, connector.connectorId, enabled);
      return remember(response.connector) ?? stateFor(providerId);
    },
    async setAgentGrant(providerId, agentId, granted) {
      const token = await loadToken();
      const connector = await connectorFor(token, providerId);
      const ids = new Set(connector.agentIds);
      if (granted) ids.add(agentId);
      else ids.delete(agentId);
      const response = await http.setAgents(token, connector.connectorId, [...ids]);
      return remember(response.connector) ?? stateFor(providerId);
    },
    async disconnect(providerId) {
      const token = await loadToken();
      const connector = await connectorFor(token, providerId);
      await http.delete(token, connector.connectorId);
      summaries.delete(providerId);
    },
    async auditLog(providerId) {
      const token = await loadToken();
      const connector = summaries.get(providerId) ?? (await refresh(token)).get(providerId);
      if (!connector) return [];
      const response = await http.audit(token, connector.connectorId, { limit: 50 });
      return (response.entries ?? []).map((entry) => connectorAuditEntryFromCloud(providerId, entry, agents));
    },
    async recheckPermission(providerId) {
      const token = await loadToken();
      await refresh(token);
      return stateFor(providerId);
    },
  };
}
