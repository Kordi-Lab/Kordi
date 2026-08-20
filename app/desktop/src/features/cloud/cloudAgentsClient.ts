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
import type { CanonicalAvatarMutation } from './canonicalAvatar';

export type CloudAgentAccessScope = 'private' | 'participant_conversations';
export type CloudAgentStatus = 'active' | 'archived';

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
  accessScope?: CloudAgentAccessScope;
  name: string;
  role: string;
  description?: string | null;
  avatarMutation?: CanonicalAvatarMutation;
  systemPrompt: string;
  sourceSummary?: string | null;
  boundaries?: string[];
  resources?: CloudAgentResource[];
  skills?: CloudAgentSkill[];
  modelRouting?: Record<string, unknown>;
};

export type UpdateCloudAgentInput = Partial<CreateCloudAgentInput>;

type CloudAgentEnvelope = { agent?: unknown };
type CloudAgentListResponse = { agents?: unknown[] };
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
    const body = await this.send<CloudAgentEnvelope>('/v1/cloud/agents', {
      method: 'POST',
      headers: this.authHeaders(token),
      body: JSON.stringify(input),
    }, 'Could not create Cloud Agent.');
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
}

export function defaultCloudAgentsClient() {
  return new CloudAgentsClient();
}
