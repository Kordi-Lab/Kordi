// Cloud-edition HTTP client. Authentication and ancillary account features
// remain under /v1/cloud; durable chat transport is exclusively /v2/chat.
// Stays independent of React. Native outbox helpers are no-ops in web/tests,
// while the focused chat client persists every send before network I/O.

// Production sessions never silently fall back to localhost; local tunnels remain
// available only by explicitly setting VITE_KORDI_CLOUD_API_BASE.
import type { CloudMessageSnapshotResponse } from './cloudMessageSnapshot';
import type { CloudContactSummary } from './cloudContactTypes';
import { buildCloudAuthError, CloudAuthError } from './cloudAuthError';
import type { CloudAuthErrorCode } from './cloudAuthError';
import { CloudDeviceClient } from './cloudDeviceClient';
import type {
  CloudDeviceListResponse,
  CloudDeviceMutationResponse,
} from './cloudDeviceClient';
import { CloudIdentityAuthClient } from './cloudIdentityAuthClient';
import {
  acceptCloudGroupInvitation,
  createCloudGroupInvitation,
  resolveCloudGroupInvitation,
  revokeCloudGroupInvitation,
} from './groupInvitationClient';
import type {
  CloudAccount,
  CloudAppInvitation,
  CloudGroupInvitationCreateInput,
  CloudGroupInvitationSummary,
  CloudPublicProfile,
} from './cloudIdentityTypes';
import { ChatSyncClient } from './chatSyncClient';
import { cloudApiBaseUrl } from './cloudApiEnvironment';
import type {
  ChatSyncBootstrapResponse,
  ChatSyncConversation,
  ChatSyncConversationInput,
  ChatSyncEvent,
  ChatSyncMessage,
} from './chatSyncTypes';
import {
  installationDeviceRegistration,
  type CloudDeviceRegistration,
} from './deviceIdentity';

export type { CloudContactSummary } from './cloudContactTypes';
export type {
  CloudDeviceAuthorization,
  CloudDeviceAuthorizationState,
  CloudDeviceListResponse,
  CloudDeviceMutationResponse,
} from './cloudDeviceClient';
export { parseCloudOAuthHashResult } from './cloudOAuthResult';
export { CloudAuthError } from './cloudAuthError';
export { chatSyncSessionTitle, cloudMessageFromChatSync, cloudOperationUuid } from './chatSyncMapping';
export type {
  ChatSyncBootstrapResponse,
  ChatSyncConversation,
  ChatSyncConversationInput,
  ChatSyncEvent,
  ChatSyncMember,
  ChatSyncMessage,
  ChatSyncPreferences,
  ChatSyncSyncResponse,
} from './chatSyncTypes';
export type { CloudAuthErrorCode } from './cloudAuthError';
export type {
  CloudAccount,
  CloudAppInvitation,
  CloudGroupInvitation,
  CloudGroupInvitationAcceptance,
  CloudGroupInvitationCreateInput,
  CloudGroupInvitationSummary,
  CloudGroupInvitationPreview,
  CloudPublicProfile,
} from './cloudIdentityTypes';

export {
  chatSyncWebSocketUrl,
  cloudApiBaseUrl,
  cloudRealtimeWebSocketEnabled,
  cloudWebSocketUrl,
  DEFAULT_CLOUD_API_BASE_URL,
  operatorCloudOAuthProviderFallback,
} from './cloudApiEnvironment';
export type { CloudApiEnvironment } from './cloudApiEnvironment';

export type CloudSession = {
  token: string;
  expiresAt: string;
  deviceId?: string;
};

export type CloudAuthResult = {
  account: CloudAccount;
  session: CloudSession;
};

export type CloudOAuthProvider = 'google' | 'github';

export type CloudAuthCapabilities = {
  password: boolean;
  oauthProviders: CloudOAuthProvider[];
};

export type CloudOAuthStartResponse = {
  authUrl: string;
};

export type CloudProfileUpdateInput = {
  displayName?: string;
  avatarUrl?: string;
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

export type SendCloudMessageOptions = {
  sessionId?: string | null;
  attachments?: SendCloudMessageAttachmentInput[];
  clientCreatedAt?: string | null;
  clientMessageId?: string | null;
  messageKind?: string | null;
  canonicalHistoryLocalMessageId?: string | null;
  accountId?: string | null;
  conversationKind?: ChatSyncConversation['kind'];
  memberAccountIds?: string[];
  sharedTitle?: string | null;
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
  conversationId?: string | null;
  conversationSequence?: number | null;
  clientMessageId?: string | null;
  messageKind?: string | null;
  canonicalHistoryLocalMessageId?: string | null;
  version?: number | null;
};


export type CloudSyncEventType = string;

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
  chat?: {
    bootstrap: boolean;
    protocolVersion: 2;
    nextCursor: string;
    lastStreamSeq: number;
    conversations: ChatSyncConversation[];
    messages: ChatSyncMessage[];
    events: ChatSyncEvent[];
  };
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
  kind: string;
  category: string;
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

export type CloudPresenceStatus = 'online' | 'offline';

export type CloudPresenceAccount = {
  accountId: string;
  status: CloudPresenceStatus;
  updatedAt: string;
  lastSeenAt: string | null;
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

export type CloudAgentRunStatus = string;

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

export type CloudAuthClientOptions = {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  deviceRegistration?: () => Promise<CloudDeviceRegistration>;
};

async function readJsonSafe(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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
  private activeAccountId: string | null = null;
  private readonly chat: ChatSyncClient;
  private readonly devices: CloudDeviceClient;
  private readonly identity: CloudIdentityAuthClient;

  constructor(options: CloudAuthClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? cloudApiBaseUrl();
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.requestTimeoutMs = options.requestTimeoutMs ?? defaultCloudRequestTimeoutMs(this.baseUrl);
    const deviceRegistration = options.deviceRegistration ?? installationDeviceRegistration;
    this.devices = new CloudDeviceClient(
      (path, init, fallbackMessage) => this.send(path, init, fallbackMessage),
      deviceRegistration,
    );
    this.identity = new CloudIdentityAuthClient(
      (path, init, fallbackMessage) => this.send(path, init, fallbackMessage),
      this.baseUrl,
      deviceRegistration,
    );
    this.chat = new ChatSyncClient({
      request: (path, init, fallbackMessage) => this.send(path, init, fallbackMessage),
      getActiveAccountId: () => this.activeAccountId,
      setActiveAccountId: (value) => { this.activeAccountId = value; },
      errorStatus: (error) => error instanceof CloudAuthError ? error.status : null,
    });
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
      throw buildCloudAuthError(response.status, body, fallbackMessage);
    }
    return body as TResponse;
  }

  request<TResponse>(path: string, init: RequestInit, fallbackMessage: string): Promise<TResponse> {
    return this.send<TResponse>(path, init, fallbackMessage);
  }

  knownChatSessionIds(accountId: string): string[] { return this.chat.knownSessionIds(accountId); }

  async signup(input: {
    email: string;
    password: string;
    displayName?: string;
    avatarUrl?: string;
  }): Promise<CloudAuthResult> {
    const result = await this.identity.signup(input);
    this.activeAccountId = result.account.accountId;
    return result;
  }

  async capabilities(): Promise<CloudAuthCapabilities> {
    return this.identity.capabilities();
  }

  async login(input: { email: string; password: string }): Promise<CloudAuthResult> {
    const result = await this.identity.login(input);
    this.activeAccountId = result.account.accountId;
    return result;
  }

  async me(token: string): Promise<CloudAccount> {
    const account = await this.identity.me(token);
    this.activeAccountId = account.accountId;
    return account;
  }

  async startOAuth(provider: CloudOAuthProvider, redirectAfter: string): Promise<CloudOAuthStartResponse> {
    return this.identity.startOAuth(provider, redirectAfter);
  }

  async updateProfile(token: string, input: CloudProfileUpdateInput): Promise<CloudAccount> {
    return this.identity.updateProfile(token, input);
  }

  async logout(token: string): Promise<void> {
    await this.identity.logout(token);
  }

  async listDevices(token: string): Promise<CloudDeviceListResponse> {
    return this.devices.list(token);
  }

  async renameDevice(
    token: string,
    deviceId: string,
    displayName: string,
    clientOperationId: string = crypto.randomUUID(),
  ): Promise<CloudDeviceMutationResponse> {
    return this.devices.rename(token, deviceId, displayName, clientOperationId);
  }

  async confirmDevice(
    token: string,
    deviceId: string,
    clientOperationId: string = crypto.randomUUID(),
  ): Promise<CloudDeviceMutationResponse> {
    return this.devices.confirm(token, deviceId, clientOperationId);
  }

  async revokeDevice(token: string, deviceId: string, clientOperationId: string = crypto.randomUUID()): Promise<CloudDeviceMutationResponse> {
    return this.devices.revoke(token, deviceId, clientOperationId);
  }

  async revokeOtherDevices(token: string, clientOperationId: string = crypto.randomUUID()): Promise<CloudDeviceMutationResponse> {
    return this.devices.revokeOthers(token, clientOperationId);
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

  async createAppInvitation(token: string): Promise<CloudAppInvitation> {
    return this.send<CloudAppInvitation>(
      '/v1/cloud/invitations/app',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      },
      'Could not create invitation.',
    );
  }

  async createGroupInvitation(
    token: string,
    input: CloudGroupInvitationCreateInput,
  ) {
    return createCloudGroupInvitation(this, token, input);
  }

  async listGroupInvitations(token: string, groupSpaceId: string): Promise<CloudGroupInvitationSummary[]> {
    const response = await this.request<{ invitations: CloudGroupInvitationSummary[] }>(
      `/v1/cloud/invitations/groups/active/${encodeURIComponent(groupSpaceId)}`,
      { method: 'GET', headers: { authorization: `Bearer ${token}` } },
      'Could not load active group invitations.',
    );
    return response.invitations;
  }

  async resolveGroupInvitation(invitationToken: string) {
    return resolveCloudGroupInvitation(this, invitationToken);
  }

  async acceptGroupInvitation(
    token: string,
    invitationToken: string,
  ) {
    return acceptCloudGroupInvitation(this, token, invitationToken);
  }

  async revokeGroupInvitation(token: string, invitationId: string): Promise<void> {
    await revokeCloudGroupInvitation(this, token, invitationId);
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

  async ensureChatConversation(token: string, input: ChatSyncConversationInput): Promise<ChatSyncConversation> { return this.chat.ensureConversation(token, input); }

  async sendMessage(token: string, peerAccountId: string, body: string, options: SendCloudMessageOptions = {}): Promise<CloudMessage> {
    return this.chat.sendMessage(token, peerAccountId, body, options);
  }

  async drainChatOutbox(token: string, accountId: string): Promise<CloudMessage[]> { return this.chat.drainOutbox(token, accountId); }

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
      throw buildCloudAuthError(response.status, body, 'Could not download attachment.');
    }
    return response.blob();
  }

  async markMessagesRead(token: string, peerAccountId: string): Promise<void> { return this.chat.markMessagesRead(token, peerAccountId); }

  async markSessionMessagesRead(token: string, sessionId: string): Promise<void> { return this.chat.markSessionMessagesRead(token, sessionId); }

  async acknowledgeChatDelivery(token: string, conversationId: string, sequence: number): Promise<void> { return this.chat.acknowledgeDelivery(token, conversationId, sequence); }

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

  async updateCloudSessionTitle(token: string, sessionId: string, input: UpdateCloudSessionTitleInput): Promise<CloudSessionTitle> { return this.chat.updateTitle(token, sessionId, input); }

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

  async syncCloudEvents(token: string, cursor: string, limit?: number): Promise<CloudSyncResponse> { return this.chat.syncEvents(token, cursor, limit); }

  async listMessageSnapshot(token: string, peerAccountId: string, limit?: number, viewerAccountId?: string | null) {
    return this.chat.listMessageSnapshot(token, peerAccountId, limit, viewerAccountId);
  }

  async listChatConversationHistoryPage(token: string, conversationId: string, beforeSequence?: number, limit = 200): Promise<{ messages: ChatSyncMessage[]; nextBeforeSequence: number | null; hasMore: boolean }> {
    return this.chat.listHistoryPage(token, conversationId, beforeSequence, limit);
  }

  async bootstrapChatSync(token: string): Promise<ChatSyncBootstrapResponse> { return this.chat.bootstrap(token); }

  async issueChatSyncRealtimeTicket(token: string): Promise<{ ticket: string; device_id: string; expires_at: string }> { return this.chat.issueRealtimeTicket(token); }

}

// Convenience factory for production callers that don't need to inject deps.
export function defaultCloudAuthClient(): CloudAuthClient {
  return new CloudAuthClient();
}
