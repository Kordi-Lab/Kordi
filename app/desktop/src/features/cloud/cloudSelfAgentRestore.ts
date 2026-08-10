import { canonicalJsonValuesEqual } from '@/features/canonical/canonicalEquality';
import type {
  AppendCanonicalMessageRequest,
  CanonicalSessionState,
  MessageActionMetadata,
} from '@/kordi-app/types';
import type {
  CloudMessage,
  CloudSessionForkSummary,
} from './authClient';
import {
  parseCloudAgentCancel,
  parseCloudAgentResponse,
} from './cloudAgentMessages';
import {
  cloudDirectMessageAction,
  cloudDirectMessageDisplayText,
} from './cloudDirectMessages';
import { parseCloudGroupControl } from './cloudGroupMessages';
import type { CloudSelfAgentResponseDeliveryState } from './cloudSelfAgentResponseLifecycle';

function cleanText(value?: string | null) {
  return (value ?? '').trim();
}

export type CloudSelfAgentRestoreMessage = {
  message: CloudMessage;
  sessionId: string;
  role: 'user' | 'agent';
  text: string;
  createdAtMs: number;
  responseRequestId: string | null;
  responseDeliveryState: CloudSelfAgentResponseDeliveryState | null;
  messageAction: MessageActionMetadata | null;
};

export function cloudSelfAgentRestoreDependencyRank(message: CloudMessage) {
  return parseCloudAgentResponse(message.body) ? 1 : 0;
}

export function cloudSelfAgentCreatedAtMs(message: CloudMessage) {
  const parsed = Date.parse(message.createdAt);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export function existingCanonicalMessageMatchesRestoreRequest(
  existing: CanonicalSessionState['messages'][number],
  request: AppendCanonicalMessageRequest,
) {
  return existing.sessionId === request.sessionId
    && existing.senderIdentityId === request.senderIdentityId
    && existing.senderRole === request.senderRole
    && existing.messageKind === request.messageKind
    && existing.contentText === request.contentText
    && canonicalJsonValuesEqual(existing.content ?? null, request.content ?? null)
    && (existing.parentMessageId ?? null) === (request.parentMessageId ?? null)
    && (existing.delegatedExchangeId ?? null)
      === (request.delegatedExchangeId ?? null)
    && existing.status === (request.status ?? 'sent')
    && existing.createdAtMs === request.createdAtMs
    && existing.sourceTransport === request.sourceTransport;
}

export function normalizeCloudSelfAgentRestoreMessage(
  message: CloudMessage,
  isSharedCloudSessionId: (sessionId: string) => boolean,
  isGroupControl?: boolean,
): CloudSelfAgentRestoreMessage | null {
  const sessionId = cleanText(message.sessionId);
  if (!sessionId || isSharedCloudSessionId(sessionId)) return null;
  const response = parseCloudAgentResponse(message.body);
  if (
    !response
    && (
      parseCloudAgentCancel(message.body)
      || (isGroupControl ?? Boolean(parseCloudGroupControl(message.body)))
    )
  ) return null;
  const text = cleanText(
    response?.text ?? cloudDirectMessageDisplayText(message.body),
  );
  if (!text) return null;
  return {
    message,
    sessionId,
    role: response ? 'agent' : 'user',
    text,
    createdAtMs: cloudSelfAgentCreatedAtMs(message),
    responseRequestId: response?.requestId ?? null,
    responseDeliveryState: response
      ? response.deliveryState ?? 'complete'
      : null,
    messageAction: response ? null : cloudDirectMessageAction(message.body),
  };
}

export function restoredForkSnapshotCloudMessageIds(
  messages: CloudSelfAgentRestoreMessage[],
  forksBySessionId: Record<string, CloudSessionForkSummary>,
): Set<string> {
  const messagesBySessionId = new Map<string, CloudSelfAgentRestoreMessage[]>();
  for (const message of messages) {
    const bucket = messagesBySessionId.get(message.sessionId) ?? [];
    bucket.push(message);
    messagesBySessionId.set(message.sessionId, bucket);
  }

  const snapshotIds = new Set<string>();
  for (const fork of Object.values(forksBySessionId)) {
    const forkSessionId = cleanText(fork.forkSessionId);
    const parentSessionId = cleanText(fork.parentSessionId);
    if (!forkSessionId || !parentSessionId) continue;
    const forkMessages = messagesBySessionId.get(forkSessionId) ?? [];
    const parentMessages = messagesBySessionId.get(parentSessionId) ?? [];
    if (forkMessages.length === 0 || parentMessages.length === 0) continue;

    for (
      let index = 0;
      index < forkMessages.length && index < parentMessages.length;
      index += 1
    ) {
      const forkMessage = forkMessages[index];
      const parentMessage = parentMessages[index];
      if (
        forkMessage.role !== parentMessage.role
        || forkMessage.text !== parentMessage.text
      ) break;
      snapshotIds.add(forkMessage.message.messageId);
    }
  }
  return snapshotIds;
}
