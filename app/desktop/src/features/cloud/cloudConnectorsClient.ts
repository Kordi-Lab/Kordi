// Typed HTTP calls for `/v1/cloud/connectors`. Every response here is built
// by the server from connector rows and agent grants only; none of these
// shapes carries a credential. Standalone like `CloudAgentsClient`, so the
// large `CloudAuthClient` does not grow.

import { cloudApiBaseUrl } from './cloudApiEnvironment';
import { buildCloudAuthError, CloudAuthError } from './cloudAuthError';
import { cloudFetchImpl, defaultCloudRequestTimeoutMs } from './cloudTransport';

export type CloudConnectorStatus = 'connected' | 'needs_reauth' | 'revoked';
export type CloudConnectorToolGroup = 'read' | 'act';

export type CloudConnectorSummary = {
  connectorId: string;
  provider: string;
  status: CloudConnectorStatus;
  readScopes: string[];
  actScopes: string[];
  actEnabled: boolean;
  agentIds: string[];
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
};

export type CloudConnectorAgent = { agentId: string; name: string; isDefault?: boolean };

export type CloudConnectorListResponse = {
  connectors: CloudConnectorSummary[];
  /** Not sent by connectorsVersion 1; read when a later server adds it. */
  agents?: CloudConnectorAgent[];
};

export type CloudConnectorResponse = { connector: CloudConnectorSummary };

export type CloudConnectorOAuthStartInput = {
  grant: CloudConnectorToolGroup;
  redirectAfter?: string;
};

export type CloudConnectorOAuthStartResponse = { authUrl: string };

export type CloudConnectorAuditEntry = {
  auditId: string;
  connectorId: string;
  runId?: string;
  agentId?: string;
  tool: string;
  toolGroup: CloudConnectorToolGroup;
  outcome: string;
  summary: string;
  createdAt: string;
};

export type CloudConnectorAuditResponse = {
  entries: CloudConnectorAuditEntry[];
  nextBefore?: string;
};

export type CloudConnectorAuditQuery = { limit?: number; before?: string };

export type CloudConnectorDisconnectResponse = { deletedEvents: number };

/** Payload the OAuth callback puts in `#kordi_connector=` after a grant. */
export type CloudConnectorOAuthCompleted = {
  connectorId: string;
  provider: string;
  grant: CloudConnectorToolGroup;
  status: CloudConnectorStatus;
};

export type CloudConnectorCallbackResult =
  | { kind: 'completed'; result: CloudConnectorOAuthCompleted }
  | { kind: 'error'; message: string; code: string | null };

export type CloudConnectorsHttpClientOptions = {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
};

const CONNECTORS_PATH = '/v1/cloud/connectors';

function connectorPath(id: string, suffix = ''): string {
  return `${CONNECTORS_PATH}/${encodeURIComponent(id)}${suffix}`;
}

async function readJsonSafe(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export class CloudConnectorsHttpClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(options: CloudConnectorsHttpClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? cloudApiBaseUrl();
    this.fetchImpl = options.fetchImpl ?? cloudFetchImpl();
    this.requestTimeoutMs = options.requestTimeoutMs ?? defaultCloudRequestTimeoutMs(this.baseUrl);
  }

  private async send<TResponse>(path: string, token: string, method: string, body: unknown, fallbackMessage: string): Promise<TResponse> {
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), this.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: body === undefined
          ? { authorization: `Bearer ${token}` }
          : { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: timeoutController.signal,
      });
    } catch (caught) {
      const message = timeoutController.signal.aborted
        ? 'Cloud request timed out. Check your connection and try again.'
        : caught instanceof Error ? caught.message : 'Network request failed.';
      throw new CloudAuthError('network_error', message, 0);
    } finally {
      clearTimeout(timeout);
    }
    const parsed = response.status === 204 ? null : await readJsonSafe(response);
    if (!response.ok) {
      throw buildCloudAuthError(response.status, parsed, fallbackMessage, response.headers.get('retry-after'));
    }
    return parsed as TResponse;
  }

  list(token: string): Promise<CloudConnectorListResponse> {
    return this.send(CONNECTORS_PATH, token, 'GET', undefined, 'Could not load connectors.');
  }

  /** The account's own agents (`/v1/cloud/agents`), used to name agent grants. */
  listAgents(token: string): Promise<{ agents?: unknown[] }> {
    return this.send('/v1/cloud/agents', token, 'GET', undefined, 'Could not list Agents.');
  }

  startOAuth(token: string, provider: string, input: CloudConnectorOAuthStartInput): Promise<CloudConnectorOAuthStartResponse> {
    const body = input.redirectAfter ? { grant: input.grant, redirectAfter: input.redirectAfter } : { grant: input.grant };
    return this.send(connectorPath(provider, '/oauth/start'), token, 'POST', body, 'Could not start connecting.');
  }

  setAct(token: string, connectorId: string, enabled: boolean): Promise<CloudConnectorResponse> {
    return this.send(connectorPath(connectorId, '/act'), token, 'POST', { enabled }, 'Could not change whether your agent can act here.');
  }

  setAgents(token: string, connectorId: string, agentIds: string[]): Promise<CloudConnectorResponse> {
    return this.send(connectorPath(connectorId, '/agents'), token, 'PUT', { agentIds }, 'Could not change which agents can use this connector.');
  }

  audit(token: string, connectorId: string, query: CloudConnectorAuditQuery = {}): Promise<CloudConnectorAuditResponse> {
    const params = new URLSearchParams();
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.before) params.set('before', query.before);
    const search = params.toString();
    return this.send(connectorPath(connectorId, `/audit${search ? `?${search}` : ''}`), token, 'GET', undefined, 'Could not load connector activity.');
  }

  delete(token: string, connectorId: string): Promise<CloudConnectorDisconnectResponse> {
    return this.send(connectorPath(connectorId), token, 'DELETE', undefined, 'Could not disconnect.');
  }
}

function decodeBase64UrlJson(value: string): unknown {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const bytes = Uint8Array.from(atob(padded), (character: string) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function completedFragment(value: unknown): CloudConnectorOAuthCompleted | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const { connectorId, provider, grant, status } = record;
  if (typeof connectorId !== 'string' || !connectorId) return null;
  if (typeof provider !== 'string' || !provider) return null;
  if (grant !== 'read' && grant !== 'act') return null;
  if (status !== 'connected' && status !== 'needs_reauth' && status !== 'revoked') return null;
  return { connectorId, provider, grant, status };
}

/**
 * Reads the connector OAuth result from a callback URL or its fragment.
 * Returns null when the fragment carries neither a result nor an error.
 */
export function parseConnectorCallbackFragment(value: string | null | undefined): CloudConnectorCallbackResult | null {
  const raw = value?.trim() ?? '';
  const hashIndex = raw.indexOf('#');
  if (hashIndex < 0) return null;
  const params = new URLSearchParams(raw.slice(hashIndex + 1));
  const errorMessage = params.get('kordi_connector_error')?.trim();
  if (errorMessage) {
    return { kind: 'error', message: errorMessage, code: params.get('kordi_connector_error_code')?.trim() || null };
  }
  const encoded = params.get('kordi_connector')?.trim();
  if (!encoded) return null;
  const result = completedFragment(decodeBase64UrlJson(encoded));
  if (!result) return { kind: 'error', message: 'The connection did not return a valid result.', code: null };
  return { kind: 'completed', result };
}
