import {
  CloudAuthError,
  cloudApiBaseUrl,
  defaultCloudRequestTimeoutMs,
  type CloudAuthClientOptions,
} from './authClient';
import {
  normalizeCloudAgentDefinition,
  normalizeSharedCloudAgentSummary,
  type CloudAgentDefinition,
  type SharedCloudAgentSummary,
} from './cloudAgents';

export type CloudAgentAccessScope = 'private' | 'participant_conversations';
export type CloudAgentStatus = 'active' | 'archived';

export type CloudAgentProactiveConfig = {
  enabled: boolean;
  skillPack: 'proact-v1';
};

export type CloudAgentMentionPermissions = {
  people: boolean;
  agents: boolean;
};

export type CloudAgentProactiveRun = {
  runId: string;
  sessionId: string;
  triggerMessageId: string;
  status: string;
  decision: 'silence' | 'intervention' | null;
  breakdown: string | null;
  selectedSkill: string | null;
  evidenceMessageIds: string[];
  skillPack: string;
  route: string;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  durationMs: number | null;
};

export type CloudAgentResource = {
  kind: 'url' | 'file' | 'text' | string;
  value: string;
  title?: string | null;
  summary?: string | null;
};

export type CloudAgentSkill = {
  name: string;
  description: string;
  content?: string | null;
};

export type CreateCloudAgentInput = {
  /** Stable local runtime identity when this definition synchronizes an installed agent. */
  sourceAgentId?: string | null;
  accessScope?: CloudAgentAccessScope;
  name: string;
  role: string;
  description?: string | null;
  systemPrompt: string;
  sourceSummary?: string | null;
  boundaries?: string[];
  resources?: CloudAgentResource[];
  skills?: CloudAgentSkill[];
  modelRouting?: Record<string, unknown>;
  proactive?: CloudAgentProactiveConfig;
  mentionPermissions?: CloudAgentMentionPermissions;
};

export type UpdateCloudAgentInput = Partial<CreateCloudAgentInput>;

type CloudAgentEnvelope = { agent?: unknown };
type CloudAgentListResponse = { agents?: unknown[] };
type CloudAgentProactiveRunsResponse = { runs?: CloudAgentProactiveRun[] };
type ServerErrorBody = { errorCode?: string; message?: string };

async function readJsonSafe(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function cloudAgentError(status: number, body: unknown, fallbackMessage: string): CloudAuthError {
  const data = (body && typeof body === 'object' ? body : {}) as ServerErrorBody;
  const message = typeof data.message === 'string' && data.message.length > 0 ? data.message : fallbackMessage;
  return new CloudAuthError('unknown', message, status);
}

export class CloudAgentsClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(options: CloudAuthClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? cloudApiBaseUrl();
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.requestTimeoutMs = options.requestTimeoutMs ?? defaultCloudRequestTimeoutMs(this.baseUrl);
  }

  private async send<TResponse>(path: string, init: RequestInit, fallbackMessage: string): Promise<TResponse> {
    let response: Response;
    const timeoutController = init.signal ? null : new AbortController();
    const timeout = timeoutController ? setTimeout(() => timeoutController.abort(), this.requestTimeoutMs) : null;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: init.signal ?? timeoutController?.signal,
      });
    } catch (caught) {
      const abortedByTimeout = timeoutController?.signal.aborted;
      const message = abortedByTimeout
        ? 'Cloud request timed out. Check your connection and try again.'
        : caught instanceof Error ? caught.message : 'Network request failed.';
      throw new CloudAuthError('network_error', message, 0);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    const body = await readJsonSafe(response);
    if (!response.ok) throw cloudAgentError(response.status, body, fallbackMessage);
    return body as TResponse;
  }

  private authHeaders(token: string): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    };
  }

  async listCloudAgents(token: string): Promise<CloudAgentDefinition[]> {
    const body = await this.send<CloudAgentListResponse>('/v1/cloud/agents', {
      method: 'GET',
      headers: this.authHeaders(token),
    }, 'Could not list Cloud Agents.');
    return (Array.isArray(body.agents) ? body.agents : [])
      .map(normalizeCloudAgentDefinition)
      .filter((agent): agent is CloudAgentDefinition => Boolean(agent));
  }

  async listSharedCloudAgents(token: string, ownerAccountIds: string[]): Promise<SharedCloudAgentSummary[]> {
    const owners = [...new Set(ownerAccountIds.map((value) => value.trim()).filter(Boolean))];
    if (owners.length === 0) return [];
    const body = await this.send<CloudAgentListResponse>(`/v1/cloud/agents/shared?ownerAccountIds=${encodeURIComponent(owners.join(','))}`, {
      method: 'GET',
      headers: this.authHeaders(token),
    }, 'Could not list shared Cloud Agents.');
    return (Array.isArray(body.agents) ? body.agents : [])
      .map(normalizeSharedCloudAgentSummary)
      .filter((agent): agent is SharedCloudAgentSummary => Boolean(agent));
  }

  async createCloudAgent(token: string, input: CreateCloudAgentInput): Promise<CloudAgentDefinition> {
    const path = input.sourceAgentId?.trim()
      ? '/v1/cloud/agents/synchronize'
      : '/v1/cloud/agents';
    const body = await this.send<CloudAgentEnvelope>(path, {
      method: 'POST',
      headers: this.authHeaders(token),
      body: JSON.stringify(input),
    }, input.sourceAgentId?.trim()
      ? 'This server cannot synchronize the local agent yet.'
      : 'Could not create agent.');
    const agent = normalizeCloudAgentDefinition(body.agent);
    if (!agent) throw new CloudAuthError('unknown', 'Cloud Agent response was invalid.', 0);
    return agent;
  }

  async updateCloudAgent(token: string, agentId: string, input: UpdateCloudAgentInput): Promise<CloudAgentDefinition> {
    const body = await this.send<CloudAgentEnvelope>(`/v1/cloud/agents/${encodeURIComponent(agentId)}`, {
      method: 'PUT',
      headers: this.authHeaders(token),
      body: JSON.stringify(input),
    }, 'Could not update Cloud Agent.');
    const agent = normalizeCloudAgentDefinition(body.agent);
    if (!agent) throw new CloudAuthError('unknown', 'Cloud Agent response was invalid.', 0);
    return agent;
  }

  async archiveCloudAgent(token: string, agentId: string): Promise<CloudAgentDefinition> {
    const body = await this.send<CloudAgentEnvelope>(`/v1/cloud/agents/${encodeURIComponent(agentId)}`, {
      method: 'DELETE',
      headers: this.authHeaders(token),
    }, 'Could not archive Cloud Agent.');
    const agent = normalizeCloudAgentDefinition(body.agent);
    if (!agent) throw new CloudAuthError('unknown', 'Cloud Agent response was invalid.', 0);
    return agent;
  }

  async listProactiveRuns(token: string, agentId: string, limit = 30): Promise<CloudAgentProactiveRun[]> {
    const body = await this.send<CloudAgentProactiveRunsResponse>(
      `/v1/cloud/agents/${encodeURIComponent(agentId)}/proactive-runs?limit=${Math.max(1, Math.min(100, Math.trunc(limit)))}`,
      {
        method: 'GET',
        headers: this.authHeaders(token),
      },
      'Could not list proactive collaboration activity.',
    );
    return Array.isArray(body.runs) ? body.runs : [];
  }
}

export function defaultCloudAgentsClient() {
  return new CloudAgentsClient();
}
