// Cloud-edition auth HTTP client. Talks to the cloud server's /v1/cloud/* routes.
// Stays a pure TS module: no React, no Tauri imports — easy to test with a fetch stub.

// Production Cloud Edition must not silently fall back to a localhost Bridge.
// Local tunnels/dev servers remain available by explicitly setting
// VITE_KORDI_CLOUD_API_BASE.
export const DEFAULT_CLOUD_API_BASE_URL = 'https://coordinar.io';

export type CloudAccount = {
  accountId: string;
  displayName: string | null;
  primaryEmail: string | null;
  avatarUrl: string | null;
  nodeId: string | null;
  passwordSet: boolean;
};

export type CloudSession = {
  token: string;
  expiresAt: string;
};

export type CloudAuthResult = {
  account: CloudAccount;
  session: CloudSession;
};

export type CloudOAuthProvider = 'google' | 'github';

export type CloudOAuthStartResponse = {
  authUrl: string;
};

export type CloudProfileUpdateInput = {
  displayName?: string;
  avatarUrl?: string;
};

export type CloudAuthErrorCode =
  | 'invalid_email'
  | 'weak_password'
  | 'email_in_use'
  | 'invalid_credentials'
  | 'missing_avatar'
  | 'invalid_avatar'
  | 'invalid_session'
  | 'rate_limited'
  | 'account_missing'
  | 'invalid_account_id'
  | 'invalid_pubkey'
  | 'self_contact'
  | 'server_error'
  | 'network_error'
  | 'unknown';

export type CloudPublicProfile = {
  accountId: string;
  displayName: string | null;
  avatarUrl: string | null;
  nodeId: string | null;
  isContact: boolean;
  isSelf: boolean;
};

export type CloudContactSummary = {
  accountId: string;
  displayName: string | null;
  avatarUrl: string | null;
  nodeId: string | null;
  createdAt: string;
};

export type CloudContactRequestDirection = 'incoming' | 'outgoing';
export type CloudContactRequestStatus = 'pending' | 'accepted' | 'rejected';

export type CloudContactRequest = {
  requestId: string;
  fromAccountId: string;
  toAccountId: string;
  status: CloudContactRequestStatus;
  direction: CloudContactRequestDirection;
  message: string | null;
  createdAt: string;
  decidedAt: string | null;
  counterpart: CloudContactSummary | null;
};

export type CloudContactAcceptResult = {
  request: CloudContactRequest;
  helloMessage?: CloudMessage | null;
};

export type CloudMessageDirection = 'incoming' | 'outgoing';

export type CloudMessageAttachment = {
  attachmentId: string;
  name: string;
  kind: 'image' | 'file';
  mimeType: string | null;
  sizeBytes: number | null;
  downloadUrl?: string | null;
  previewUrl?: string | null;
  localPath?: string | null;
};

export type SendCloudMessageAttachmentInput = {
  attachmentId: string;
  name: string;
  kind: 'image' | 'file';
  mimeType?: string | null;
  sizeBytes?: number | null;
};

export type CloudAttachmentInitiateResult = {
  attachmentId: string;
  objectKey: string;
  uploadUrl: string;
  expiresAt: string;
};

export type CloudAttachmentFinalizeResult = {
  attachmentId: string;
  objectKey: string;
  sizeBytes: number | null;
  contentType: string | null;
  sha256Hex: string | null;
  finalizedAt: string | null;
};

export type CloudAttachmentDownloadUrlResult = {
  attachmentId: string;
  downloadUrl: string;
  expiresAt: string;
};

export type CloudMessage = {
  messageId: string;
  fromAccountId: string;
  toAccountId: string;
  body: string;
  createdAt: string;
  deliveredAt: string | null;
  readAt: string | null;
  direction: CloudMessageDirection;
  sessionId?: string | null;
  attachments?: CloudMessageAttachment[];
};

export type CloudSyncEventType = 'message.upsert' | 'message.read' | string;

export type CloudSyncEvent = {
  eventId: string;
  eventType: CloudSyncEventType;
  peerAccountId: string | null;
  messageId: string | null;
  payload: unknown;
  occurredAt: string;
};

export type CloudSyncResponse = {
  cursor: string;
  hasMore: boolean;
  events: CloudSyncEvent[];
};

export type CloudSessionForkSummary = {
  forkSessionId: string;
  parentSessionId: string;
  parentMessageId?: string | null;
  createdByAccountId: string;
  createdAt: string;
};

export type CloudTaskActivity = {
  taskActivityId: string;
  sessionId: string;
  taskId: string;
  title: string;
  summary: string | null;
  status: string;
  createdByAccountId: string;
  targetAccountId: string | null;
  participants: unknown[];
  artifactIds: string[];
  responseMessageId: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type CloudArtifactActivity = {
  artifactActivityId: string;
  sessionId: string;
  artifactId: string;
  name: string;
  path: string;
  kind: 'code' | 'document' | 'file' | string;
  category: 'artifact' | 'related' | 'memory' | string;
  summary: string | null;
  createdByAccountId: string;
  sourceMessageId: string | null;
  attachmentId: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type CloudSessionActivity = {
  tasks: CloudTaskActivity[];
  artifacts: CloudArtifactActivity[];
};

export type CloudSessionVisibility = {
  hiddenSessionIds: string[];
  deletedSessionIds: string[];
};

export type CloudAgentRuntimeReachabilityState = 'online' | 'offline';
export type CloudAgentRuntimeLocalExecutionState = 'available' | 'paused';

export type CloudAgentRuntimeStatusInput = {
  reachabilityState: CloudAgentRuntimeReachabilityState;
  localExecutionState: CloudAgentRuntimeLocalExecutionState;
  readonlyFallbackEnabled: boolean;
};

export type CloudAgentRuntimeStatusSummary = {
  accountId: string;
  reachabilityState: CloudAgentRuntimeReachabilityState;
  localExecutionState: CloudAgentRuntimeLocalExecutionState;
  readonlyFallbackEnabled: boolean;
  updatedAt: string | null;
};

export type CloudAgentProviderAuthSnapshotInput = {
  formatVersion: number;
  authJson: unknown;
  activeProvider?: string | null;
  activeProfileId?: string | null;
};

export type CloudAgentProviderAuthSnapshotSummary = {
  accountId: string;
  formatVersion: number;
  activeProvider: string | null;
  activeProfileId: string | null;
  updatedAt: string;
};

export type UpsertCloudTaskActivityInput = Omit<CloudTaskActivity, 'taskActivityId' | 'createdAt' | 'updatedAt' | 'archivedAt'> & {
  participantAccountIds: string[];
  clientUpdatedAt?: string | null;
};

export type UpsertCloudArtifactActivityInput = Omit<CloudArtifactActivity, 'artifactActivityId' | 'createdAt' | 'updatedAt' | 'archivedAt'> & {
  participantAccountIds: string[];
  clientUpdatedAt?: string | null;
};

export type RegisterDeviceResult = {
  nodeId: string;
  apiKey: string;
};

export class CloudAuthError extends Error {
  readonly code: CloudAuthErrorCode;
  readonly status: number;

  constructor(code: CloudAuthErrorCode, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = 'CloudAuthError';
  }
}

function cleanBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

export function cloudApiBaseUrl(env?: { VITE_KORDI_CLOUD_API_BASE?: string }): string {
  const fromEnv = env?.VITE_KORDI_CLOUD_API_BASE;
  if (fromEnv && fromEnv.trim().length > 0) return cleanBaseUrl(fromEnv);
  if (typeof import.meta !== 'undefined') {
    const meta = (import.meta as ImportMeta & { env?: { VITE_KORDI_CLOUD_API_BASE?: string } }).env;
    if (meta?.VITE_KORDI_CLOUD_API_BASE && meta.VITE_KORDI_CLOUD_API_BASE.trim().length > 0) {
      return cleanBaseUrl(meta.VITE_KORDI_CLOUD_API_BASE);
    }
  }
  return DEFAULT_CLOUD_API_BASE_URL;
}

export function cloudWebSocketUrl(token: string, baseUrl = cloudApiBaseUrl()): string {
  const url = new URL('/v1/cloud/ws', baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('token', token);
  return url.toString();
}

export function closeCloudWebSocketQuietly(socket: WebSocket | null | undefined): void {
  if (!socket) return;
  const openState = typeof WebSocket === 'undefined' ? 1 : WebSocket.OPEN;
  const connectingState = typeof WebSocket === 'undefined' ? 0 : WebSocket.CONNECTING;
  try {
    if (socket.readyState === openState) {
      socket.close();
      return;
    }
    if (socket.readyState === connectingState) {
      socket.addEventListener('open', () => {
        try {
          if (socket.readyState === openState) socket.close();
        } catch {
          // Best effort cleanup; avoid surfacing dev-tunnel close noise.
        }
      }, { once: true });
    }
  } catch {
    // Best effort cleanup; a failed close should not create visible app errors.
  }
}

export type CloudAuthClientOptions = {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

type ServerErrorBody = { errorCode?: string; message?: string };

function isErrorCode(value: unknown): value is CloudAuthErrorCode {
  return (
    value === 'invalid_email' ||
    value === 'weak_password' ||
    value === 'email_in_use' ||
    value === 'invalid_credentials' ||
    value === 'missing_avatar' ||
    value === 'invalid_avatar' ||
    value === 'invalid_session' ||
    value === 'rate_limited' ||
    value === 'account_missing' ||
    value === 'invalid_account_id' ||
    value === 'invalid_pubkey' ||
    value === 'self_contact' ||
    value === 'server_error'
  );
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

function buildError(status: number, body: unknown, fallbackMessage: string): CloudAuthError {
  const data = (body as ServerErrorBody) ?? {};
  const code = isErrorCode(data.errorCode) ? data.errorCode : 'unknown';
  const message = typeof data.message === 'string' && data.message.length > 0
    ? data.message
    : fallbackMessage;
  return new CloudAuthError(code, message, status);
}

export class CloudAuthClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CloudAuthClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? cloudApiBaseUrl();
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private async send<TResponse>(
    path: string,
    init: RequestInit,
    fallbackMessage: string,
  ): Promise<TResponse> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Network request failed.';
      throw new CloudAuthError('network_error', message, 0);
    }
    if (response.status === 204) {
      return undefined as TResponse;
    }
    const body = await readJsonSafe(response);
    if (!response.ok) {
      throw buildError(response.status, body, fallbackMessage);
    }
    return body as TResponse;
  }

  async signup(input: {
    email: string;
    password: string;
    displayName?: string;
    avatarUrl?: string;
  }): Promise<CloudAuthResult> {
    return this.send<CloudAuthResult>(
      '/v1/cloud/auth/signup',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      },
      'Could not create account.',
    );
  }

  async login(input: { email: string; password: string }): Promise<CloudAuthResult> {
    return this.send<CloudAuthResult>(
      '/v1/cloud/auth/login',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      },
      'Could not sign in.',
    );
  }

  async me(token: string): Promise<CloudAccount> {
    return this.send<CloudAccount>(
      '/v1/cloud/auth/me',
      {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      },
      'Could not load account.',
    );
  }

  async startOAuth(provider: CloudOAuthProvider, redirectAfter: string): Promise<CloudOAuthStartResponse> {
    const params = new URLSearchParams({ redirectAfter });
    return this.send<CloudOAuthStartResponse>(
      `/v1/cloud/auth/oauth/${encodeURIComponent(provider)}/start?${params.toString()}`,
      { method: 'GET' },
      'Could not start social sign-in.',
    );
  }

  async updateProfile(token: string, input: CloudProfileUpdateInput): Promise<CloudAccount> {
    return this.send<CloudAccount>(
      '/v1/cloud/auth/me',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(input),
      },
      'Could not update profile.',
    );
  }

  async logout(token: string): Promise<void> {
    await this.send<void>(
      '/v1/cloud/auth/logout',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      },
      'Could not sign out.',
    );
  }

  async registerDevice(
    token: string,
    input: { ed25519Pubkey: string; x25519Pubkey: string; displayName?: string },
  ): Promise<RegisterDeviceResult> {
    return this.send<RegisterDeviceResult>(
      '/v1/cloud/auth/register-device',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(input),
      },
      'Could not register device on bridges.',
    );
  }

  async getProfile(token: string, accountId: string): Promise<CloudPublicProfile> {
    return this.send<CloudPublicProfile>(
      `/v1/cloud/accounts/${encodeURIComponent(accountId)}/profile`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      },
      'Could not load profile.',
    );
  }

  async addContact(token: string, peerAccountId: string): Promise<void> {
    await this.send<void>(
      '/v1/cloud/contacts',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ peerAccountId }),
      },
      'Could not add contact.',
    );
  }

  async listContacts(token: string): Promise<CloudContactSummary[]> {
    const response = await this.send<{ contacts: CloudContactSummary[] }>(
      '/v1/cloud/contacts',
      {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      },
      'Could not load contacts.',
    );
    return response?.contacts ?? [];
  }

  async sendContactRequest(
    token: string,
    peerAccountId: string,
    message?: string,
  ): Promise<CloudContactRequest> {
    const response = await this.send<{ request: CloudContactRequest }>(
      '/v1/cloud/contacts/requests',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ peerAccountId, message }),
      },
      'Could not send contact request.',
    );
    if (!response) throw new Error('Empty response from cloud server.');
    return response.request;
  }

  async listContactRequests(token: string): Promise<CloudContactRequest[]> {
    const response = await this.send<{ requests: CloudContactRequest[] }>(
      '/v1/cloud/contacts/requests',
      {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      },
      'Could not load contact requests.',
    );
    return response?.requests ?? [];
  }

  async acceptContactRequest(token: string, requestId: string): Promise<CloudContactAcceptResult> {
    const response = await this.send<CloudContactAcceptResult>(
      `/v1/cloud/contacts/requests/${encodeURIComponent(requestId)}/accept`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      },
      'Could not accept contact request.',
    );
    if (!response) throw new Error('Empty response from cloud server.');
    return response;
  }

  async rejectContactRequest(token: string, requestId: string): Promise<void> {
    await this.send<void>(
      `/v1/cloud/contacts/requests/${encodeURIComponent(requestId)}/reject`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      },
      'Could not reject contact request.',
    );
  }

  async sendMessage(token: string, peerAccountId: string, body: string, options: { sessionId?: string | null; attachments?: SendCloudMessageAttachmentInput[]; clientCreatedAt?: string | null } = {}): Promise<CloudMessage> {
    const trimmedSessionId = options.sessionId?.trim() ?? '';
    const attachments = options.attachments ?? [];
    const response = await this.send<{ message: CloudMessage }>(
      '/v1/cloud/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          peerAccountId,
          body,
          ...(trimmedSessionId ? { sessionId: trimmedSessionId } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(options.clientCreatedAt?.trim() ? { clientCreatedAt: options.clientCreatedAt.trim() } : {}),
        }),
      },
      'Could not send message.',
    );
    if (!response) throw new Error('Empty response from cloud server.');
    return { ...response.message, attachments: response.message.attachments ?? [] };
  }

  async syncCloudAgentRuntimeStatus(token: string, input: CloudAgentRuntimeStatusInput): Promise<CloudAgentRuntimeStatusSummary> {
    const response = await this.send<{ status: CloudAgentRuntimeStatusSummary }>(
      '/v1/cloud/agents/runtime-status',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          reachabilityState: input.reachabilityState,
          localExecutionState: input.localExecutionState,
          readonlyFallbackEnabled: input.readonlyFallbackEnabled,
        }),
      },
      'Could not sync agent runtime status.',
    );
    if (!response) throw new Error('Empty response from cloud server.');
    return response.status;
  }

  async syncCloudAgentProviderAuthSnapshot(token: string, input: CloudAgentProviderAuthSnapshotInput): Promise<CloudAgentProviderAuthSnapshotSummary> {
    const response = await this.send<{ snapshot: CloudAgentProviderAuthSnapshotSummary }>(
      '/v1/cloud/agents/provider-auth-snapshot',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          formatVersion: input.formatVersion,
          authJson: input.authJson,
          ...(input.activeProvider?.trim() ? { activeProvider: input.activeProvider.trim() } : {}),
          ...(input.activeProfileId?.trim() ? { activeProfileId: input.activeProfileId.trim() } : {}),
        }),
      },
      'Could not sync provider authentication.',
    );
    if (!response) throw new Error('Empty response from cloud server.');
    return response.snapshot;
  }

  async initiateAttachment(token: string): Promise<CloudAttachmentInitiateResult> {
    return this.send<CloudAttachmentInitiateResult>(
      '/v1/cloud/attachments/initiate',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      },
      'Could not start attachment upload.',
    );
  }

  async finalizeAttachment(
    token: string,
    attachmentId: string,
    input: { sizeBytes: number; contentType?: string | null; sha256Hex?: string | null },
  ): Promise<CloudAttachmentFinalizeResult> {
    return this.send<CloudAttachmentFinalizeResult>(
      `/v1/cloud/attachments/${encodeURIComponent(attachmentId)}/finalize`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          sizeBytes: input.sizeBytes,
          contentType: input.contentType ?? null,
          sha256Hex: input.sha256Hex ?? null,
        }),
      },
      'Could not finish attachment upload.',
    );
  }

  async uploadAttachment(token: string, blob: Blob): Promise<CloudAttachmentFinalizeResult> {
    const initiated = await this.initiateAttachment(token);
    return this.send<CloudAttachmentFinalizeResult>(
      `/v1/cloud/attachments/${encodeURIComponent(initiated.attachmentId)}/upload`,
      {
        method: 'PUT',
        headers: {
          ...(blob.type ? { 'content-type': blob.type } : {}),
          authorization: `Bearer ${token}`,
        },
        body: blob,
      },
      'Could not upload attachment bytes.',
    );
  }

  async downloadAttachmentUrl(token: string, attachmentId: string): Promise<CloudAttachmentDownloadUrlResult> {
    return this.send<CloudAttachmentDownloadUrlResult>(
      `/v1/cloud/attachments/${encodeURIComponent(attachmentId)}/download-url`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      },
      'Could not download attachment.',
    );
  }

  async downloadAttachmentContent(token: string, attachmentId: string): Promise<Blob> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/cloud/attachments/${encodeURIComponent(attachmentId)}/content`, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Network request failed.';
      throw new CloudAuthError('network_error', message, 0);
    }
    if (!response.ok) {
      const body = await readJsonSafe(response);
      throw buildError(response.status, body, 'Could not download attachment.');
    }
    return response.blob();
  }

  async markMessagesRead(token: string, peerAccountId: string): Promise<void> {
    await this.send<void>(
      '/v1/cloud/messages/read',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ peerAccountId }),
      },
      'Could not mark messages read.',
    );
  }

  async listSessionVisibility(token: string): Promise<CloudSessionVisibility> {
    const response = await this.send<CloudSessionVisibility>(
      '/v1/cloud/sessions/visibility',
      {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      },
      'Could not load hidden cloud chats.',
    );
    return {
      hiddenSessionIds: response?.hiddenSessionIds ?? [],
      deletedSessionIds: response?.deletedSessionIds ?? [],
    };
  }

  async hideCloudSession(token: string, sessionId: string): Promise<void> {
    await this.send<void>(
      `/v1/cloud/sessions/${encodeURIComponent(sessionId)}/hidden`,
      {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}` },
      },
      'Could not hide cloud chat.',
    );
  }

  async unhideCloudSession(token: string, sessionId: string): Promise<void> {
    await this.send<void>(
      `/v1/cloud/sessions/${encodeURIComponent(sessionId)}/hidden`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      },
      'Could not unhide cloud chat.',
    );
  }

  async deleteCloudSession(token: string, sessionId: string): Promise<void> {
    await this.send<void>(
      `/v1/cloud/sessions/${encodeURIComponent(sessionId)}`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      },
      'Could not remove cloud chat.',
    );
  }

  async listSessionForks(token: string, sourceSessionId: string): Promise<CloudSessionForkSummary[]> {
    const response = await this.send<{ forks: CloudSessionForkSummary[] }>(
      `/v1/cloud/sessions/${encodeURIComponent(sourceSessionId)}/forks`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      },
      'Could not list cloud session forks.',
    );
    return response?.forks ?? [];
  }

  async createSessionFork(token: string, sourceSessionId: string, input: { forkSessionId: string; parentMessageId?: string | null }): Promise<CloudSessionForkSummary> {
    const response = await this.send<{ fork: CloudSessionForkSummary }>(
      `/v1/cloud/sessions/${encodeURIComponent(sourceSessionId)}/forks`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          forkSessionId: input.forkSessionId,
          parentMessageId: input.parentMessageId ?? null,
        }),
      },
      'Could not create cloud session fork.',
    );
    if (!response) throw new Error('Empty response from cloud server.');
    return response.fork;
  }

  async listSessionActivity(token: string, sessionId: string): Promise<CloudSessionActivity> {
    const params = new URLSearchParams({ sessionId });
    const response = await this.send<CloudSessionActivity>(
      `/v1/cloud/session-activity?${params.toString()}`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      },
      'Could not load session activity.',
    );
    return { tasks: response?.tasks ?? [], artifacts: response?.artifacts ?? [] };
  }

  async upsertTaskActivity(token: string, input: UpsertCloudTaskActivityInput): Promise<CloudTaskActivity> {
    const response = await this.send<{ task: CloudTaskActivity }>(
      '/v1/cloud/session-activity/tasks',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(input),
      },
      'Could not sync task activity.',
    );
    if (!response) throw new Error('Empty response from cloud server.');
    return response.task;
  }

  async upsertArtifactActivity(token: string, input: UpsertCloudArtifactActivityInput): Promise<CloudArtifactActivity> {
    const response = await this.send<{ artifact: CloudArtifactActivity }>(
      '/v1/cloud/session-activity/artifacts',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(input),
      },
      'Could not sync artifact activity.',
    );
    if (!response) throw new Error('Empty response from cloud server.');
    return response.artifact;
  }

  async syncCloudEvents(token: string, cursor: string, limit?: number): Promise<CloudSyncResponse> {
    const params = new URLSearchParams({ cursor });
    if (limit !== undefined) params.set('limit', String(limit));
    const response = await this.send<CloudSyncResponse>(
      `/v1/cloud/sync?${params.toString()}`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      },
      'Could not sync cloud changes.',
    );
    return response ?? { cursor, hasMore: false, events: [] };
  }

  async listMessages(
    token: string,
    peerAccountId: string,
    limit?: number,
  ): Promise<CloudMessage[]> {
    const params = new URLSearchParams({ peerAccountId });
    if (limit !== undefined) params.set('limit', String(limit));
    const response = await this.send<{ messages: CloudMessage[] }>(
      `/v1/cloud/messages?${params.toString()}`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      },
      'Could not load messages.',
    );
    return (response?.messages ?? []).map((message) => ({ ...message, attachments: message.attachments ?? [] }));
  }
}

function decodeBase64UrlJson<T>(value: string): T | null {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character: string) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

export function parseCloudOAuthHashResult(hash: string | null | undefined): CloudAuthResult | null {
  const trimmed = hash?.trim() ?? '';
  if (!trimmed.startsWith('#')) return null;
  const params = new URLSearchParams(trimmed.slice(1));
  const encoded = params.get('kordi_cloud_oauth');
  if (!encoded) return null;
  const parsed = decodeBase64UrlJson<CloudAuthResult>(encoded);
  if (!parsed?.account?.accountId || !parsed.session?.token || !parsed.session?.expiresAt) return null;
  return parsed;
}

// Convenience factory for production callers that don't need to inject deps.
export function defaultCloudAuthClient(): CloudAuthClient {
  return new CloudAuthClient();
}
