import type {
  CloudAccount,
  CloudAuthClient,
  CloudSyncEvent,
} from './authClient';
import { cloudOperationUuid } from './chatSyncMapping';
import type { ChatSyncConversation } from './chatSyncTypes';
import type { Conversation } from '@/kordi-app/types';

export type CloudCallKind = 'voice' | 'video' | 'meeting';
export type CloudCallState = 'ringing' | 'active' | 'ended';
export type CloudCallParticipantState = string;

export type CloudCallParticipant = {
  accountId: string;
  displayName: string | null;
  avatarUrl: string | null;
  state: CloudCallParticipantState;
  joinedAt: string | null;
  leftAt: string | null;
};

export type CloudCall = {
  id: string;
  revision: number;
  conversationId: string;
  kind: CloudCallKind;
  state: CloudCallState;
  createdByAccountId: string;
  createdAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  participants: CloudCallParticipant[];
};

export type CloudCallMedia = {
  url: string;
  token: string;
};

export type CloudCallSession = {
  call: CloudCall;
  media: CloudCallMedia;
};

export type ActiveCloudCall = {
  call: CloudCall;
  sessionId: string | null;
};

export type CloudCallTarget = {
  sessionId: string;
  peerAccountId: string;
  kind: ChatSyncConversation['kind'];
  memberAccountIds: string[];
  sharedTitle: string | null;
};

type CloudCallTransport = Pick<CloudAuthClient, 'ensureChatConversation' | 'request'>;

type CloudCallApiParticipant = {
  account_id?: unknown;
  display_name?: unknown;
  avatar_url?: unknown;
  state?: unknown;
  joined_at?: unknown;
  left_at?: unknown;
};

type CloudCallApiSnapshot = {
  id?: unknown;
  revision?: unknown;
  conversation_id?: unknown;
  kind?: unknown;
  state?: unknown;
  created_by_account_id?: unknown;
  created_at?: unknown;
  answered_at?: unknown;
  ended_at?: unknown;
  participants?: unknown;
};

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function requiredString(value: unknown, label: string): string {
  const result = optionalString(value);
  if (!result) throw new Error(`Calling returned an invalid ${label}.`);
  return result;
}

function isCallKind(value: unknown): value is CloudCallKind {
  return value === 'voice' || value === 'video' || value === 'meeting';
}

function isCallState(value: unknown): value is CloudCallState {
  return value === 'ringing' || value === 'active' || value === 'ended';
}

export function normalizeCloudCall(value: unknown): CloudCall | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as CloudCallApiSnapshot;
  if (!isCallKind(input.kind) || !isCallState(input.state)) return null;
  try {
    const participantValues = Array.isArray(input.participants) ? input.participants : [];
    const participants = participantValues.flatMap((participantValue) => {
      if (!participantValue || typeof participantValue !== 'object' || Array.isArray(participantValue)) return [];
      const participant = participantValue as CloudCallApiParticipant;
      const accountId = optionalString(participant.account_id);
      if (!accountId) return [];
      return [{
        accountId,
        displayName: optionalString(participant.display_name),
        avatarUrl: optionalString(participant.avatar_url),
        state: optionalString(participant.state) ?? 'invited',
        joinedAt: optionalString(participant.joined_at),
        leftAt: optionalString(participant.left_at),
      }];
    });
    const endedAt = optionalString(input.ended_at);
    const revision = typeof input.revision === 'number'
      && Number.isSafeInteger(input.revision)
      && input.revision > 0
      ? input.revision
      : 0;
    return {
      id: requiredString(input.id, 'call id'),
      revision,
      conversationId: requiredString(input.conversation_id, 'conversation id'),
      kind: input.kind,
      state: endedAt ? 'ended' : input.state,
      createdByAccountId: requiredString(input.created_by_account_id, 'caller id'),
      createdAt: requiredString(input.created_at, 'creation time'),
      answeredAt: optionalString(input.answered_at),
      endedAt,
      participants,
    };
  } catch {
    return null;
  }
}

function stableSessionId(conversation: Conversation): string {
  return (conversation.canonicalSessionId || conversation.id).trim();
}

function canonicalHumanAccountIds(conversation: Conversation): string[] {
  return [...new Set((conversation.canonicalParticipants ?? [])
    .filter((participant) => participant.kind === 'human')
    .map((participant) => participant.humanId?.trim() ?? '')
    .filter((accountId) => accountId.startsWith('acct_')))];
}

function isGroupConversation(conversation: Conversation, humanAccountIds: string[]): boolean {
  const sessionId = stableSessionId(conversation);
  return sessionId.startsWith('session:group:')
    || conversation.participantSpaceId?.startsWith('group:') === true
    || humanAccountIds.length > 2;
}

export function cloudCallTargetForConversation(
  account: Pick<CloudAccount, 'accountId'> | null,
  conversation: Conversation,
): CloudCallTarget | null {
  if (!account?.accountId || conversation.transientDraft || conversation.forkedFromSessionId) return null;
  const sessionId = stableSessionId(conversation);
  if (!sessionId || conversation.supportTicketEnabled) return null;
  const humanAccountIds = canonicalHumanAccountIds(conversation);
  const group = isGroupConversation(conversation, humanAccountIds);
  if (group) {
    const memberAccountIds = humanAccountIds.filter((accountId) => accountId !== account.accountId);
    if (memberAccountIds.length === 0) return null;
    return {
      sessionId,
      peerAccountId: memberAccountIds[0],
      kind: 'group',
      memberAccountIds,
      sharedTitle: conversation.name.trim() || null,
    };
  }
  const peerAccountId = conversation.identity?.remoteHumanId?.trim()
    || conversation.collaborationTarget?.humanId?.trim()
    || humanAccountIds.find((candidate) => candidate !== account.accountId)
    || '';
  if (!peerAccountId.startsWith('acct_') || peerAccountId === account.accountId) return null;
  return {
    sessionId,
    peerAccountId,
    kind: 'direct',
    memberAccountIds: [peerAccountId],
    sharedTitle: null,
  };
}

function authHeaders(token: string, includeJson = false): HeadersInit {
  return {
    authorization: `Bearer ${token}`,
    ...(includeJson ? { 'content-type': 'application/json' } : {}),
  };
}

function normalizeSessionResponse(value: unknown): CloudCallSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Calling returned an empty response.');
  }
  const response = value as { call?: unknown; media?: { url?: unknown; token?: unknown } };
  const call = normalizeCloudCall(response.call);
  if (!call || !response.media) throw new Error('Calling returned an invalid response.');
  return {
    call,
    media: {
      url: requiredString(response.media.url, 'media server URL'),
      token: requiredString(response.media.token, 'media token'),
    },
  };
}

function normalizeCallResponse(value: unknown): CloudCall | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return normalizeCloudCall((value as { call?: unknown }).call);
}

export class CloudCallClient {
  constructor(private readonly client: CloudCallTransport) {}

  private async ensureConversation(
    token: string,
    accountId: string,
    target: CloudCallTarget,
  ): Promise<ChatSyncConversation> {
    return this.client.ensureChatConversation(token, {
      accountId,
      peerAccountId: target.peerAccountId,
      sessionId: target.sessionId,
      kind: target.kind,
      memberAccountIds: target.memberAccountIds,
      sharedTitle: target.sharedTitle,
    });
  }

  async start(
    token: string,
    accountId: string,
    target: CloudCallTarget,
    kind: CloudCallKind,
  ): Promise<CloudCallSession> {
    const conversation = await this.ensureConversation(token, accountId, target);
    const response = await this.client.request<unknown>(
      `/v2/chat/conversations/${encodeURIComponent(conversation.id)}/calls`,
      {
        method: 'POST',
        headers: authHeaders(token, true),
        body: JSON.stringify({
          client_operation_id: cloudOperationUuid(),
          kind,
        }),
      },
      'Could not start the call.',
    );
    return normalizeSessionResponse(response);
  }

  async active(
    token: string,
    accountId: string,
    target: CloudCallTarget,
  ): Promise<CloudCall | null> {
    const conversation = await this.ensureConversation(token, accountId, target);
    const response = await this.client.request<unknown>(
      `/v2/chat/conversations/${encodeURIComponent(conversation.id)}/calls/active`,
      { method: 'GET', headers: authHeaders(token) },
      'Could not check the current call.',
    );
    return normalizeCallResponse(response);
  }

  async listActive(token: string): Promise<ActiveCloudCall[]> {
    const response = await this.client.request<unknown>(
      '/v2/calls/active',
      { method: 'GET', headers: authHeaders(token) },
      'Could not check active calls.',
    );
    if (!response || typeof response !== 'object' || Array.isArray(response)) return [];
    const values = (response as { calls?: unknown }).calls;
    if (!Array.isArray(values)) return [];
    return values.flatMap((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const entry = value as { call?: unknown; session_id?: unknown };
      const call = normalizeCloudCall(entry.call);
      return call ? [{ call, sessionId: optionalString(entry.session_id) }] : [];
    });
  }

  async join(token: string, callId: string): Promise<CloudCallSession> {
    return this.sessionMutation(token, callId, 'join', 'Could not join the call.');
  }

  async invite(token: string, callId: string): Promise<CloudCall | null> {
    return this.callMutation(token, callId, 'invite', 'Could not invite call participants.');
  }

  async decline(token: string, callId: string): Promise<CloudCall | null> {
    return this.callMutation(token, callId, 'decline', 'Could not decline the call.');
  }

  async leave(token: string, callId: string): Promise<CloudCall | null> {
    return this.callMutation(token, callId, 'leave', 'Could not leave the call.');
  }

  async end(token: string, callId: string): Promise<CloudCall | null> {
    return this.callMutation(token, callId, 'end', 'Could not end the call.');
  }

  private async sessionMutation(
    token: string,
    callId: string,
    action: string,
    fallbackMessage: string,
  ): Promise<CloudCallSession> {
    const response = await this.client.request<unknown>(
      `/v2/calls/${encodeURIComponent(callId)}/${action}`,
      { method: 'POST', headers: authHeaders(token) },
      fallbackMessage,
    );
    return normalizeSessionResponse(response);
  }

  private async callMutation(
    token: string,
    callId: string,
    action: string,
    fallbackMessage: string,
  ): Promise<CloudCall | null> {
    const response = await this.client.request<unknown>(
      `/v2/calls/${encodeURIComponent(callId)}/${action}`,
      { method: 'POST', headers: authHeaders(token) },
      fallbackMessage,
    );
    return normalizeCallResponse(response);
  }
}

export const CLOUD_CALLS_CHANGED_EVENT = 'kordi-cloud-calls-changed';

export type CloudCallsChangedDetail = {
  accountId: string;
  calls: Array<{ call: CloudCall; sessionId: string | null }>;
};

export function publishCloudCallEvents(events: CloudSyncEvent[], accountId: string): void {
  if (typeof window === 'undefined') return;
  const calls = events.flatMap((event) => {
    if (event.eventType !== 'call.created' && event.eventType !== 'call.updated') return [];
    if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) return [];
    const payload = event.payload as { call?: unknown; sessionId?: unknown };
    const call = normalizeCloudCall(payload.call);
    return call ? [{ call, sessionId: optionalString(payload.sessionId) }] : [];
  });
  if (calls.length === 0) return;
  window.dispatchEvent(new CustomEvent<CloudCallsChangedDetail>(CLOUD_CALLS_CHANGED_EVENT, {
    detail: { accountId, calls },
  }));
}

export async function requestCallMediaAccess(
  kind: CloudCallKind,
  mediaDevices: Pick<MediaDevices, 'getUserMedia'> = navigator.mediaDevices,
): Promise<void> {
  const stream = await mediaDevices.getUserMedia({
    audio: true,
    video: kind !== 'voice',
  });
  for (const track of stream.getTracks()) track.stop();
}

export function callMediaErrorMessage(error: unknown): string {
  const name = error && typeof error === 'object' && 'name' in error
    ? String(error.name)
    : '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return 'Allow Kordi to use your microphone and camera in System Settings, then try again.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'Kordi could not find the microphone or camera needed for this call.';
  }
  return error instanceof Error && error.message.trim()
    ? error.message
    : 'Kordi could not access your microphone or camera.';
}

export function callConnectionErrorMessage(error: unknown): string {
  const reason = error && typeof error === 'object' && 'reasonName' in error
    ? String(error.reasonName)
    : '';
  if (reason === 'WebSocket' || reason === 'ServiceNotFound' || reason === 'NotAllowed') {
    return 'Call signaling failed. Check the server connection and try again.';
  }
  if (reason === 'Timeout' || reason === 'ServerUnreachable') {
    return 'Call media could not establish an ICE or TURN connection.';
  }
  return 'Call signaling or media transport failed. Check your connection and try again.';
}
