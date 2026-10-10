export type CloudMemoryScope = 'conversation' | 'group' | 'project';
export type CloudMemorySource = 'user_correction' | 'repeated_failure' | 'outcome' | 'manual';

export type CloudMemory = {
  memoryId: string;
  scope: CloudMemoryScope;
  scopeId: string;
  scopeLabel: string | null;
  source: CloudMemorySource;
  text: string;
  createdAt: string;
  updatedAt: string;
};

export type CloudMemorySettings = { memoryEnabled: boolean; excludeSensitive: boolean };
export type CloudMemorySettingsPatch = Partial<CloudMemorySettings>;

export type CloudMemoryListResponse = { memories: CloudMemory[]; settings: CloudMemorySettings };

type CloudMemoryRequest = <TResponse>(
  path: string,
  init: RequestInit,
  fallbackMessage: string,
) => Promise<TResponse>;

function authorized(token: string, method: string, body?: unknown): RequestInit {
  if (body === undefined) return { method, headers: { authorization: `Bearer ${token}` } };
  return {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  };
}

/** Account memory routes. Server error messages surface through the request helper. */
export class CloudMemoryClient {
  constructor(private readonly request: CloudMemoryRequest) {}

  list(token: string): Promise<CloudMemoryListResponse> {
    return this.request<CloudMemoryListResponse>('/v1/cloud/memory', authorized(token, 'GET'), 'Could not load memories.');
  }

  async update(token: string, memoryId: string, text: string): Promise<CloudMemory> {
    const response = await this.request<{ memory: CloudMemory }>(
      `/v1/cloud/memory/${encodeURIComponent(memoryId)}`,
      authorized(token, 'PATCH', { text }),
      'Could not save this memory.',
    );
    return response.memory;
  }

  async remove(token: string, memoryId: string): Promise<void> {
    await this.request<void>(
      `/v1/cloud/memory/${encodeURIComponent(memoryId)}`,
      authorized(token, 'DELETE'),
      'Could not delete this memory.',
    );
  }

  forgetAll(token: string): Promise<{ archived: number }> {
    return this.request<{ archived: number }>('/v1/cloud/memory', authorized(token, 'DELETE'), 'Could not forget memories.');
  }

  settings(token: string): Promise<CloudMemorySettings> {
    return this.request<CloudMemorySettings>(
      '/v1/cloud/memory/settings',
      authorized(token, 'GET'),
      'Could not load memory settings.',
    );
  }

  updateSettings(token: string, patch: CloudMemorySettingsPatch): Promise<CloudMemorySettings> {
    return this.request<CloudMemorySettings>(
      '/v1/cloud/memory/settings',
      authorized(token, 'PUT', patch),
      'Could not save memory settings.',
    );
  }
}
