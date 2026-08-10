import type {
  CloudAccount,
  CloudMessage,
} from './authClient';
import {
  cloudGroupAgentRequestingNoticeMessage,
  parseCloudGroupControl,
} from './cloudGroupMessages';
import { parseCloudAgentResponse } from './cloudAgentMessages';
import type { IndexedCloudGroupRow } from './cloudMessageIndex';
import type {
  AppendCanonicalMessageRequest,
  CanonicalSessionMessage,
  CanonicalSessionState,
} from '@/kordi-app/types';
import {
  canApplyCloudAgentTurnTransition,
  isTerminalCloudAgentTurn,
} from '@/features/canonical/cloudAgentTurnLifecycle';

export type CloudAgentRequestCandidate = {
  requestMessage: CanonicalSessionMessage;
  targetAccountId: string;
  targetHumanDisplayName: string;
  targetAgentDisplayName: string;
  targetCloudAgentId?: string | null;
  targetCloudAgentName?: string | null;
  targetCloudAgentOwnerName?: string | null;
};

export type CloudFallbackClaimAttemptResult =
  | 'claimed'
  | 'already-claimed'
  | 'terminal'
  | 'in-flight'
  | 'retryable-failure'
  | 'terminal-failure'
  | 'not-signed-in';

function objectContent(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function cleanText(value?: string | null) {
  return (value ?? '').trim();
}

function cloudGroupRequestSlotMatches(
  message: CanonicalSessionMessage,
  noticeId: string,
) {
  return message.id === noticeId;
}

export function cloudAgentRequestReachedCloud(
  message: CanonicalSessionMessage,
): boolean {
  const content = objectContent(message.content);
  const deliveryState = cleanText(
    typeof content.deliveryState === 'string' ? content.deliveryState : null,
  ).toLowerCase();
  return ['sent', 'delivered', 'read'].includes(message.status.trim().toLowerCase())
    || ['sent', 'delivered', 'read'].includes(deliveryState);
}

function cloudGroupOfflinePlaceholderMatches(
  message: CanonicalSessionMessage,
  noticeId: string,
) {
  if (
    !cloudGroupRequestSlotMatches(message, noticeId)
    || message.sourceTransport !== 'cloud-group-agent-offline'
  ) return false;
  const content = objectContent(message.content);
  const deliveryState = cleanText(
    typeof content.deliveryState === 'string' ? content.deliveryState : null,
  ).toLowerCase();
  const status = message.status.trim().toLowerCase();
  return !['failed', 'cancelled'].includes(status)
    && !['failed', 'cancelled'].includes(deliveryState);
}

function cloudGroupAgentResponseMatches(
  message: CanonicalSessionMessage,
  candidate: CloudAgentRequestCandidate,
) {
  if (message.senderIdentityId !== `agent:cloud:${candidate.targetAccountId}`) {
    return false;
  }
  if (message.sourceTransport !== 'cloud-group-agent') return false;
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
  return linkedRequestId === candidate.requestMessage.id;
}

export function upsertCanonicalRequestIntoLocalState(
  current: CanonicalSessionState | null,
  request: AppendCanonicalMessageRequest,
): CanonicalSessionState | null {
  if (!current) return current;
  const id = request.id?.trim();
  if (!id) return current;
  const createdAtMs = request.createdAtMs ?? Date.now();
  const existingIndex = current.messages.findIndex((message) => message.id === id);
  const existing = existingIndex >= 0 ? current.messages[existingIndex] : null;
  if (
    existing?.sourceTransport === 'cloud-group-agent'
    && request.sourceTransport === 'cloud-group-agent-offline'
  ) {
    const content = objectContent(existing.content);
    const deliveryState = cleanText(
      typeof content.deliveryState === 'string'
        ? content.deliveryState
        : null,
    ).toLowerCase();
    const status = existing.status.trim().toLowerCase();
    if (
      !['sending', 'processing'].includes(status)
      && !['sending', 'processing'].includes(deliveryState)
    ) return current;
  }
  const nextMessage: CanonicalSessionMessage = {
    id,
    sessionId: request.sessionId,
    senderIdentityId: request.senderIdentityId,
    senderRole: request.senderRole,
    messageKind: request.messageKind,
    contentText: request.contentText,
    content: request.content ?? {},
    parentMessageId: request.parentMessageId ?? null,
    delegatedExchangeId: request.delegatedExchangeId ?? null,
    status: request.status ?? 'sent',
    sequenceNum: existing?.sequenceNum ?? current.messages
      .filter((message) => message.sessionId === request.sessionId)
      .reduce((max, message) => Math.max(max, message.sequenceNum), 0) + 1,
    createdAtMs: existing?.createdAtMs ?? createdAtMs,
    updatedAtMs: createdAtMs,
    contentHash: existing?.contentHash ?? null,
    sourceTransport: request.sourceTransport ?? null,
    sourceEventId: request.sourceEventId ?? null,
  };
  if (existing && !canApplyCloudAgentTurnTransition(existing, nextMessage)) {
    return current;
  }
  const messages = existingIndex >= 0
    ? current.messages.map((message, index) => (
      index === existingIndex ? nextMessage : message
    ))
    : [...current.messages, nextMessage];
  return { ...current, messages };
}

export const CLOUD_GROUP_AGENT_UNAVAILABLE_NOTICE =
  'Cloud Agent did not reply yet. The owner device may be offline or still starting.';

export function cloudGroupAgentUnavailableFallbackRequest(input: {
  sessionId: string;
  requestMessageId: string;
  targetAccountId: string;
  targetAgentDisplayName?: string | null;
  createdAtMs?: number | null;
}): AppendCanonicalMessageRequest {
  const createdAtMs = typeof input.createdAtMs === 'number'
    && Number.isFinite(input.createdAtMs)
    ? input.createdAtMs
    : Date.now();
  const requestMessageId = input.requestMessageId.trim();
  const targetAccountId = input.targetAccountId.trim();
  return {
    id: `msg:cloud-agent-offline:${requestMessageId}:${targetAccountId}`,
    sessionId: input.sessionId,
    senderIdentityId: `agent:cloud:${targetAccountId}`,
    senderRole: 'external-agent',
    messageKind: 'agent-turn',
    contentText: '',
    content: {
      sender: input.targetAgentDisplayName?.trim() || 'Kordi',
      timestampMs: createdAtMs,
      deliveryState: 'failed',
      requestId: requestMessageId,
      replyToMessageId: requestMessageId,
      error: CLOUD_GROUP_AGENT_UNAVAILABLE_NOTICE,
    },
    parentMessageId: requestMessageId,
    status: 'failed',
    createdAtMs,
    sourceTransport: 'cloud-group-agent-offline',
    sourceEventId:
      `cloud-group-agent-unavailable-timeout:${requestMessageId}:${targetAccountId}`,
  };
}

function cloudGroupTerminalTimeoutPlaceholderMatches(
  message: CanonicalSessionMessage,
  noticeId: string,
) {
  if (!cloudGroupRequestSlotMatches(message, noticeId)) return false;
  return message.sourceTransport === 'cloud-group-agent-offline'
    || message.sourceEventId?.startsWith(
      'cloud-group-agent-unavailable-timeout:',
    ) === true
    || message.sourceEventId?.startsWith(
      'cloud-group-agent-no-provider-timeout:',
    ) === true;
}

export function removeCloudGroupOfflinePlaceholder(
  current: CanonicalSessionState | null,
  noticeId: string,
): CanonicalSessionState | null {
  if (!current) return current;
  const nextMessages = current.messages.filter(
    (message) => !cloudGroupOfflinePlaceholderMatches(message, noticeId),
  );
  return nextMessages.length === current.messages.length
    ? current
    : { ...current, messages: nextMessages };
}

export function cloudGroupPendingAgentRowMatches(
  message: CanonicalSessionMessage,
  requestId: string,
  targetAccountId: string,
) {
  const trimmedRequestId = requestId.trim();
  const trimmedTargetAccountId = targetAccountId.trim();
  if (!trimmedRequestId || !trimmedTargetAccountId) return false;
  if (message.senderIdentityId !== `agent:cloud:${trimmedTargetAccountId}`) {
    return false;
  }
  if (!message.sourceTransport?.startsWith('cloud-group-agent')) return false;
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
  const status = message.status.trim().toLowerCase();
  const deliveryState = cleanText(
    typeof content.deliveryState === 'string' ? content.deliveryState : null,
  ).toLowerCase();
  return status === 'queued'
    || status === 'processing'
    || deliveryState === 'queued'
    || deliveryState === 'processing'
    || message.sourceTransport === 'cloud-group-agent-offline'
    || message.sourceEventId?.startsWith(
      'cloud-group-agent-unavailable-timeout:',
    ) === true
    || message.sourceEventId?.startsWith(
      'cloud-group-agent-no-provider-timeout:',
    ) === true;
}

export function removeCloudGroupTimeoutPlaceholderForTerminalResponse(
  current: CanonicalSessionState | null,
  noticeId: string,
): CanonicalSessionState | null {
  if (!current) return current;
  const nextMessages = current.messages.filter(
    (message) => !cloudGroupTerminalTimeoutPlaceholderMatches(message, noticeId),
  );
  return nextMessages.length === current.messages.length
    ? current
    : { ...current, messages: nextMessages };
}

export function removeCloudGroupPendingRowsForTerminalResponse(
  current: CanonicalSessionState | null,
  requestId: string,
  targetAccountId: string,
): CanonicalSessionState | null {
  if (!current) return current;
  const nextMessages = current.messages.filter(
    (message) => !cloudGroupPendingAgentRowMatches(
      message,
      requestId,
      targetAccountId,
    ),
  );
  return nextMessages.length === current.messages.length
    ? current
    : { ...current, messages: nextMessages };
}

export function removeCanonicalMessageById(
  current: CanonicalSessionState | null,
  messageId: string,
): CanonicalSessionState | null {
  if (!current) return current;
  const nextMessages = current.messages.filter(
    (message) => message.id !== messageId,
  );
  return nextMessages.length === current.messages.length
    ? current
    : { ...current, messages: nextMessages };
}

export function collapseCloudAgentOfflinePlaceholderForRequest(
  nextState: CanonicalSessionState,
  processingMessage: CanonicalSessionMessage,
  requestId: string,
): CanonicalSessionState {
  const prefix = 'agent:cloud:';
  const senderIdentityId = processingMessage.senderIdentityId;
  if (!senderIdentityId.startsWith(prefix)) return nextState;
  const targetAccountId = senderIdentityId.slice(prefix.length).trim();
  if (!targetAccountId) return nextState;
  const offlinePlaceholderId =
    `msg:cloud-agent-offline:${requestId.trim()}:${targetAccountId}`;
  return removeCloudGroupOfflinePlaceholder(nextState, offlinePlaceholderId)
    ?? nextState;
}

export function setCloudGroupRequestPlaceholderProcessing(
  current: CanonicalSessionState | null,
  candidate: CloudAgentRequestCandidate,
  noticeId: string,
): CanonicalSessionState | null {
  if (!current) return current;
  let changed = false;
  const updatedAtMs = Date.now();
  const nextMessages = current.messages.flatMap(
    (message): CanonicalSessionMessage[] => {
      if (cloudGroupRequestSlotMatches(message, noticeId)) {
        const content = objectContent(message.content);
        const deliveryState = cleanText(
          typeof content.deliveryState === 'string'
            ? content.deliveryState
            : null,
        ).toLowerCase();
        if (isTerminalCloudAgentTurn(message)) return [message];
        if (
          message.status === 'processing'
          && deliveryState === 'processing'
          && message.contentText === 'processing...'
        ) return [message];
        changed = true;
        return [{
          ...message,
          contentText: 'processing...',
          content: {
            ...content,
            deliveryState: 'processing',
            timestampMs: typeof content.timestampMs === 'number'
              ? content.timestampMs
              : updatedAtMs,
          },
          status: 'processing',
          updatedAtMs,
        }];
      }
      if (cloudGroupAgentResponseMatches(message, candidate)) {
        if (isTerminalCloudAgentTurn(message)) return [message];
        changed = true;
        return [];
      }
      return [message];
    },
  );
  return changed ? { ...current, messages: nextMessages } : current;
}

export function appendCloudGroupRequestingPlaceholder(
  current: CanonicalSessionState | null,
  candidate: CloudAgentRequestCandidate,
  noticeId: string,
): CanonicalSessionState | null {
  if (
    !current
    || current.messages.some((message) => message.id === noticeId)
  ) return current;
  const createdAtMs = Date.now();
  return {
    ...current,
    messages: [
      ...current.messages,
      cloudGroupAgentRequestingNoticeMessage({
        sessionId: candidate.requestMessage.sessionId,
        requestMessageId: candidate.requestMessage.id,
        targetAccountId: candidate.targetAccountId,
        targetAgentDisplayName: candidate.targetAgentDisplayName,
        createdAtMs,
        sequenceNum: candidate.requestMessage.sequenceNum + 1,
      }),
    ],
  };
}

export function isCloudAgentProcessingPlaceholderText(text: string): boolean {
  return /^processing[.\s…]*$/iu.test(text.trim());
}

export function cloudAgentResponseExistsForRequest({
  account,
  requestMessageId,
  peerMessages,
}: {
  account: CloudAccount;
  requestMessageId: string;
  peerMessages: readonly CloudMessage[];
}): boolean {
  return peerMessages.some((candidate) => (
    candidate.fromAccountId === account.accountId
    && parseCloudAgentResponse(candidate.body)?.requestId === requestMessageId
  ));
}

export function cloudGroupAgentResponseExistsForRequest({
  localAccountId,
  requestMessageId,
  messages = [],
  groupRows = [],
  ignoreFailedCloudFallback = false,
}: {
  localAccountId: string;
  requestMessageId: string;
  messages?: readonly CloudMessage[];
  groupRows?: readonly IndexedCloudGroupRow[];
  ignoreFailedCloudFallback?: boolean;
}): boolean {
  const trimmedLocalAccountId = localAccountId.trim();
  const trimmedRequestMessageId = requestMessageId.trim();
  if (!trimmedLocalAccountId || !trimmedRequestMessageId) return false;
  const parsedRows = messages.flatMap((wire) => {
    const envelope = parseCloudGroupControl(wire.body);
    return envelope
      ? [{ wire, envelope, canonicalMessageId: cleanText(envelope.message?.id) || null }]
      : [];
  });
  return [...groupRows, ...parsedRows].some(({ envelope }) => {
    if (envelope?.kind !== 'group-message' || !envelope.message) return false;
    if (envelope.message.senderKind !== 'agent') return false;
    if (envelope.message.senderAccountId !== trimmedLocalAccountId) return false;
    if (envelope.message.deliveryState === 'processing') return false;
    if (
      ignoreFailedCloudFallback
      && envelope.message.deliveryState === 'failed'
      && envelope.message.id.startsWith('cloudrunmsg_')
    ) return false;
    const linkedRequestId = cleanText(envelope.message.requestId)
      || cleanText(envelope.message.replyToMessageId);
    return linkedRequestId === trimmedRequestMessageId;
  });
}
