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
  | 'invalid_session_id'
  | 'invalid_attachment'
  | 'invalid_provider_auth_snapshot'
  | 'provider_auth_not_configured'
  | 'provider_auth_snapshot_not_found'
  | 'requester_mismatch'
  | 'agent_not_available'
  | 'owner_online'
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
  previewAttachmentId?: string | null;
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
  previewUrl?: string | null;
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

export type CloudAttachmentPreviewUpdateResult = {
  attachmentId: string;
  previewUrl: string;
  updatedLinks: number;
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

export type CloudSessionPin = {
  sessionId: string;
  sharedMessageId: string | null;
  privateMessageId: string | null;
  effectiveMessageId: string | null;
  updatedAt: string | null;
};

export type CloudSessionTitle = {
  sessionId: string;
  title: string;
  titleSource: 'placeholder' | 'auto' | 'imported' | 'external' | 'legacy' | 'manual';
  titleRevision: number;
  titlePolicyVersion: number;
  titleGeneratedFromMessageId: string | null;
  updatedAtMs: number;
  updatedByAccountId: string;
  updatedAt: string;
};

export type UpdateCloudSessionTitleInput = Pick<
  CloudSessionTitle,
  'title' | 'titleSource' | 'titleRevision' | 'titlePolicyVersion' | 'titleGeneratedFromMessageId' | 'updatedAtMs'
>;

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

export type CloudPresenceStatus = 'online' | 'offline';

export type CloudPresenceAccount = {
  accountId: string;
  status: CloudPresenceStatus;
  updatedAt: string;
};

export type CloudPresenceContactsResponse = {
  accounts: CloudPresenceAccount[];
};

export type CloudProviderAuthSnapshotInput = {
  provider: string;
  authChoice: string;
  payload: unknown;
};

export type CloudProviderAuthSnapshot = {
  snapshotId: string;
  provider: string;
  authChoice: string;
  createdAt: string;
  revokedAt: string | null;
};

export type CloudAgentRunClaimInput = {
  requestMessageId: string;
  sessionId: string;
  ownerAccountId: string;
  requesterAccountId: string;
  prompt: string;
  idempotencyKey: string;
  targetCloudAgentId?: string | null;
};

export type CloudAgentRunStatus = 'queued' | 'leased' | 'running' | 'completed' | 'failed' | 'cancelled' | string;

export type CloudAgentRun = {
  runId: string;
  status: CloudAgentRunStatus;
  sandboxId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CloudAgentRunLookup = {
  run: CloudAgentRun | null;
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

function isProductionCloudOrigin(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/\.+$/, '');
    return hostname === new URL(DEFAULT_CLOUD_API_BASE_URL).hostname;
  } catch {
    return value === DEFAULT_CLOUD_API_BASE_URL;
  }
}

type CloudApiEnvironment = {
  DEV?: boolean;
  VITE_KORDI_CLOUD_API_BASE?: string;
};

export function cloudApiBaseUrl(env?: CloudApiEnvironment): string {
  const meta = typeof import.meta !== 'undefined'
    ? (import.meta as ImportMeta & { env?: CloudApiEnvironment }).env
    : undefined;
  const activeEnv = env ?? meta;
  const configured = activeEnv?.VITE_KORDI_CLOUD_API_BASE?.trim();

  if (activeEnv?.DEV) {
    if (!configured) {
      throw new Error('VITE_KORDI_CLOUD_API_BASE is required for development.');
    }
    const cleaned = cleanBaseUrl(configured);
    if (isProductionCloudOrigin(cleaned)) {
      throw new Error('Production Cloud API is blocked in development.');
    }
    return cleaned;
  }

  if (configured) return cleanBaseUrl(configured);
  return DEFAULT_CLOUD_API_BASE_URL;
}

export function cloudRealtimeWebSocketEnabled(baseUrl = cloudApiBaseUrl()): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host !== '127.0.0.1' && host !== 'localhost' && host !== '::1';
  } catch {
    return true;
  }
}

export function cloudWebSocketUrl(token: string, baseUrl = cloudApiBaseUrl()): string {
  const url = new URL('/v1/cloud/ws', baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('token', token);
  return url.toString();
}

export type CloudAuthClientOptions = {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
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
    value === 'invalid_session_id' ||
    value === 'invalid_attachment' ||
    value === 'invalid_provider_auth_snapshot' ||
    value === 'provider_auth_not_configured' ||
    value === 'provider_auth_snapshot_not_found' ||
    value === 'requester_mismatch' ||
    value === 'agent_not_available' ||
    value === 'owner_online' ||
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

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const LOCAL_TUNNEL_REQUEST_TIMEOUT_MS = 45_000;

export function defaultCloudRequestTimeoutMs(baseUrl: string): number {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost' || host === '::1') {
      return LOCAL_TUNNEL_REQUEST_TIMEOUT_MS;
    }
  } catch {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }
  return DEFAULT_REQUEST_TIMEOUT_MS;
}

export class CloudAuthClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(options: CloudAuthClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? cloudApiBaseUrl();
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.requestTimeoutMs = options.requestTimeoutMs ?? defaultCloudRequestTimeoutMs(this.baseUrl);
  }

  private async send<TResponse>(
    path: string,
    init: RequestInit,
    fallbackMessage: string,
  ): Promise<TResponse> {
    let response: Response;
    const timeoutController = init.signal ? null : new AbortController();
    const timeout = timeoutController
      ? setTimeout(() => timeoutController.abort(), this.requestTimeoutMs)
      : null;
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

  async publishPresenceOnline(token: string): Promise<CloudPresenceAccount> {
    return this.send<CloudPresenceAccount>(
      '/v1/cloud/presence/online',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      },
      'Could not update presence.',
    );
  }

  async publishPresenceHeartbeat(token: string): Promise<CloudPresenceAccount> {
    return this.send<CloudPresenceAccount>(
      '/v1/cloud/presence/heartbeat',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      },
      'Could not update presence.',
    );
  }

  async publishPresenceOffline(token: string): Promise<CloudPresenceAccount> {
    return this.send<CloudPresenceAccount>(
      '/v1/cloud/presence/offline',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        keepalive: true,
      },
      'Could not update presence.',
    );
  }

  async listContactPresence(token: string): Promise<CloudPresenceContactsResponse> {
    return this.send<CloudPresenceContactsResponse>(
      '/v1/cloud/presence/contacts',
      {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      },
      'Could not load presence.',
    );
  }

  async publishProviderAuthSnapshot(
    token: string,
    input: CloudProviderAuthSnapshotInput,
  ): Promise<CloudProviderAuthSnapshot> {
    return this.send<CloudProviderAuthSnapshot>(
      '/v1/cloud/agent-provider-auth/snapshots',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(input),
      },
      'Could not publish Cloud provider-auth snapshot.',
    );
  }

  async currentProviderAuthSnapshot(
    token: string,
    input: { provider?: string; authChoice?: string } = {},
  ): Promise<CloudProviderAuthSnapshot | null> {
    const params = new URLSearchParams();
    if (input.provider?.trim()) params.set('provider', input.provider.trim());
    if (input.authChoice?.trim()) params.set('authChoice', input.authChoice.trim());
    const suffix = params.toString() ? `?${params.toString()}` : '';
    const response = await this.send<{ snapshot: CloudProviderAuthSnapshot | null }>(
      `/v1/cloud/agent-provider-auth/snapshots/current${suffix}`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      },
      'Could not load Cloud provider-auth snapshot.',
    );
    return response?.snapshot ?? null;
  }

  async revokeProviderAuthSnapshot(token: string, snapshotId: string): Promise<CloudProviderAuthSnapshot> {
    return this.send<CloudProviderAuthSnapshot>(
      `/v1/cloud/agent-provider-auth/snapshots/${encodeURIComponent(snapshotId)}`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      },
      'Could not revoke Cloud provider-auth snapshot.',
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

  async claimCloudAgentRun(token: string, input: CloudAgentRunClaimInput): Promise<CloudAgentRun> {
    return this.send<CloudAgentRun>(
      '/v1/cloud/agent-runs/claim',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(input),
      },
      'Could not request Kordi fallback.',
    );
  }

  async lookupCloudAgentRunForRequest(token: string, requestMessageId: string): Promise<CloudAgentRun | null> {
    const encoded = encodeURIComponent(requestMessageId.trim());
    const response = await this.send<CloudAgentRunLookup>(
      `/v1/cloud/agent-runs/request/${encoded}`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      },
      'Could not load Kordi fallback status.',
    );
    return response?.run ?? null;
  }

  async sendMessage(token: string, peerAccountId: string, body: string, options: { sessionId?: string | null; attachments?: SendCloudMessageAttachmentInput[]; clientCreatedAt?: string | null; clientMessageId?: string | null } = {}): Promise<CloudMessage> {
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
          ...(options.clientMessageId?.trim() ? { clientMessageId: options.clientMessageId.trim() } : {}),
        }),
      },
      'Could not send message.',
    );
    if (!response) throw new Error('Empty response from cloud server.');
    return { ...response.message, attachments: response.message.attachments ?? [] };
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

  async updateAttachmentPreview(token: string, attachmentId: string, previewUrl: string): Promise<CloudAttachmentPreviewUpdateResult> {
    return this.send<CloudAttachmentPreviewUpdateResult>(
      `/v1/cloud/attachments/${encodeURIComponent(attachmentId)}/preview`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ previewUrl }),
      },
      'Could not recover attachment preview.',
    );
  }

  async downloadAttachmentContent(token: string, attachmentId: string, signal?: AbortSignal): Promise<Blob> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/cloud/attachments/${encodeURIComponent(attachmentId)}/content`, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
        signal,
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

  async markSessionMessagesRead(token: string, sessionId: string): Promise<void> {
    await this.send<void>(
      `/v1/cloud/sessions/${encodeURIComponent(sessionId)}/read`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      },
      'Could not mark session messages read.',
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

  async getCloudSessionPin(token: string, sessionId: string): Promise<CloudSessionPin> {
    const response = await this.send<{ pin: CloudSessionPin }>(
      `/v1/cloud/sessions/${encodeURIComponent(sessionId)}/pin`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      },
      'Could not load pinned message.',
    );
    if (!response?.pin) throw new Error('Empty response from cloud server.');
    return response.pin;
  }

  async updateCloudSessionPin(token: string, sessionId: string, input: { messageId: string | null; scope: 'private' | 'shared' }): Promise<CloudSessionPin> {
    const response = await this.send<{ pin: CloudSessionPin }>(
      `/v1/cloud/sessions/${encodeURIComponent(sessionId)}/pin`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ messageId: input.messageId, scope: input.scope }),
      },
      'Could not update pinned message.',
    );
    if (!response?.pin) throw new Error('Empty response from cloud server.');
    return response.pin;
  }

  async updateCloudSessionTitle(token: string, sessionId: string, input: UpdateCloudSessionTitleInput): Promise<CloudSessionTitle> {
    const response = await this.send<{ sessionTitle: CloudSessionTitle }>(
      `/v1/cloud/sessions/${encodeURIComponent(sessionId)}/title`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(input),
      },
      'Could not synchronize the session title.',
    );
    if (!response?.sessionTitle) throw new Error('Empty response from cloud server.');
    return response.sessionTitle;
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
