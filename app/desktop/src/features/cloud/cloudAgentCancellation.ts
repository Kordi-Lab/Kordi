import type {
  AppendCanonicalMessageRequest,
  CanonicalSessionMessage,
  CanonicalSessionState,
} from '@/kordi-app/types';
import type { CloudAccount, CloudMessage } from './authClient';
import { encodeCloudAgentCancel } from './cloudAgentMessages';

function objectContent(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function cleanText(value?: string | null) {
  return (value ?? '').trim();
}

export function optimisticCloudAgentCancelMessage({
  account,
  peerAccountId,
  requestId,
  now = Date.now(),
}: {
  account: CloudAccount;
  peerAccountId: string;
  requestId: string;
  now?: number;
}): CloudMessage {
  const trimmedRequestId = requestId.trim();
  const trimmedPeerAccountId = peerAccountId.trim();
  return {
    messageId:
      `local-cloud-agent-cancel:${trimmedRequestId}:${trimmedPeerAccountId}`,
    fromAccountId: account.accountId,
    toAccountId: trimmedPeerAccountId,
    body: encodeCloudAgentCancel({ requestId: trimmedRequestId }),
    createdAt: new Date(now).toISOString(),
    deliveredAt: null,
    readAt: null,
    direction: 'outgoing',
  };
}

export function cloudGroupAgentProcessingMessageForRequest(
  messages: CanonicalSessionMessage[],
  groupId: string,
  requestId: string,
): CanonicalSessionMessage | null {
  const trimmedGroupId = groupId.trim();
  const trimmedRequestId = requestId.trim();
  if (!trimmedGroupId || !trimmedRequestId) return null;
  return messages.find((message) => {
    if (
      message.sessionId !== trimmedGroupId
      || !message.sourceTransport?.startsWith('cloud-group-agent')
    ) return false;
    const content = objectContent(message.content);
    const linkedRequestId = cleanText(message.parentMessageId)
      || cleanText(
        typeof content.requestId === 'string' ? content.requestId : null,
      )
      || cleanText(
        typeof content.replyToMessageId === 'string'
          ? content.replyToMessageId
          : null,
      );
    if (linkedRequestId !== trimmedRequestId) return false;
    const deliveryState = cleanText(
      typeof content.deliveryState === 'string'
        ? content.deliveryState
        : null,
    ).toLowerCase();
    return message.status === 'processing'
      || deliveryState === 'processing';
  }) ?? null;
}

export type CloudGroupAgentCancelRole =
  | 'sender'
  | 'agent owner'
  | 'participant';

export function cloudGroupAgentCancelledNoticeRequest({
  processingMessage,
  requestId,
  conversationId,
  cancelledByAccountId,
  cancelledByRole,
  now,
}: {
  processingMessage: CanonicalSessionMessage;
  requestId: string;
  conversationId: string;
  cancelledByAccountId: string;
  cancelledByRole: CloudGroupAgentCancelRole;
  now?: number;
}): AppendCanonicalMessageRequest {
  const content = objectContent(processingMessage.content);
  const stableTimestampMs =
    typeof content.timestampMs === 'number'
    && Number.isFinite(content.timestampMs)
      ? content.timestampMs
      : processingMessage.createdAtMs;
  const noticeTimestampMs =
    typeof now === 'number' && Number.isFinite(now)
      ? now
      : stableTimestampMs;
  const trimmedRequestId = requestId.trim();
  const trimmedCancelledByAccountId =
    cancelledByAccountId.trim() || 'local';
  const role = cancelledByRole || 'participant';
  const text = `Request canceled by ${role}.`;
  // Overwrite the request's processing slot. Reusing a separate cancel ID can
  // leave two rows and lets timeout reconciliation oscillate the UI.
  const noticeId = processingMessage.id;
  return {
    id: noticeId,
    sessionId: processingMessage.sessionId,
    senderIdentityId: processingMessage.senderIdentityId,
    senderRole: processingMessage.senderRole,
    messageKind: 'agent-turn',
    contentText: text,
    content: {
      sender:
        typeof content.sender === 'string' ? content.sender : 'Kordi',
      timestampMs: noticeTimestampMs,
      deliveryState: 'cancelled',
      sourceConversationId: conversationId,
      requestId: trimmedRequestId,
      replyToMessageId: trimmedRequestId,
      cancelledByAccountId: trimmedCancelledByAccountId,
      cancelledByRole: role,
    },
    createdAtMs: noticeTimestampMs,
    parentMessageId: trimmedRequestId,
    status: 'cancelled',
    sourceTransport: 'cloud-group-agent',
    sourceEventId:
      `cloud-group-agent-cancel:${trimmedRequestId}`
      + `:${trimmedCancelledByAccountId}`,
  };
}

function accountIdForHumanIdentity(
  state: CanonicalSessionState,
  identityId?: string | null,
): string | null {
  const identity = identityId
    ? state.identities.find((candidate) => candidate.id === identityId)
    : null;
  if (!identity || identity.kind !== 'human') return null;
  const metadata = objectContent(identity.metadata);
  return cleanText(identity.humanId)
    || cleanText(identity.sourceIdentityId)
    || cleanText(
      typeof metadata.accountId === 'string' ? metadata.accountId : null,
    )
    || null;
}

export function cloudGroupAgentCancelRoleForRequest({
  state,
  requestId,
  processingMessage,
  cancelledByAccountId,
}: {
  state: CanonicalSessionState;
  requestId: string;
  processingMessage: CanonicalSessionMessage;
  cancelledByAccountId: string;
}): CloudGroupAgentCancelRole {
  const trimmedCancelledByAccountId = cancelledByAccountId.trim();
  const requestMessage = state.messages.find(
    (message) => message.id === requestId.trim(),
  ) ?? null;
  const requestSenderAccountId = accountIdForHumanIdentity(
    state,
    requestMessage?.senderIdentityId,
  );
  if (
    requestSenderAccountId
    && requestSenderAccountId === trimmedCancelledByAccountId
  ) return 'sender';
  const agentOwnerAccountId =
    processingMessage.senderIdentityId.startsWith('agent:cloud:')
      ? processingMessage.senderIdentityId.slice('agent:cloud:'.length)
      : null;
  if (
    agentOwnerAccountId
    && agentOwnerAccountId === trimmedCancelledByAccountId
  ) return 'agent owner';
  return 'participant';
}
