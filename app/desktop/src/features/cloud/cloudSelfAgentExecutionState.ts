import type {
  CanonicalSessionState,
  DesktopChatTurnSnapshot,
} from '@/kordi-app/types';
import type { CloudAccount, CloudMessage } from './authClient';
import { cloudSelfAgentRequestClientMessageId } from './cloudSelfAgentIdentity';
import {
  cloudMessageIsSelfAgentRequest,
  parseCloudAgentCancel,
  parseCloudAgentResponse,
} from './cloudAgentMessages';
import { cloudDirectMessageAction } from './cloudDirectMessages';
import { cloudMessageActionAllowsAgentTrigger } from './cloudAgentTriggerPolicy';
import type { CloudMessageIndex } from './cloudMessageIndex';
import { cloudSyncedLocalAgentSessionIds } from './cloudSelfAgentSessionIdentity';

const CLOUD_SELF_AGENT_LOCAL_EXECUTION_WINDOW_MS = 10 * 60_000;

export function cloudSelfAgentHasTerminalResponse(
  requestMessageId: string,
  messages: readonly CloudMessage[],
): boolean {
  return messages.some((message) => {
    const response = parseCloudAgentResponse(message.body);
    return response?.requestId === requestMessageId
      && response.deliveryState !== 'processing';
  });
}

export function cloudSelfAgentTerminalResponseRequestIds(
  messages: readonly CloudMessage[],
): Set<string> {
  return new Set(messages.flatMap((message) => {
    const response = parseCloudAgentResponse(message.body);
    return response && response.deliveryState !== 'processing'
      ? [response.requestId]
      : [];
  }));
}

export function omitTerminalCloudSelfAgentLocalTurns(
  localTurns: Record<string, DesktopChatTurnSnapshot>,
  terminalRequestIds: ReadonlySet<string>,
): Record<string, DesktopChatTurnSnapshot> {
  let next: Record<string, DesktopChatTurnSnapshot> | null = null;
  for (const requestId of terminalRequestIds) {
    if (!(requestId in localTurns)) continue;
    next ??= { ...localTurns };
    delete next[requestId];
  }
  return next ?? localTurns;
}

function contentRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function terminalLocalAgentMessage(message: CanonicalSessionState['messages'][number]) {
  if (message.sourceTransport?.startsWith('cloud-')) return false;
  if (message.messageKind !== 'agent-turn' && !message.senderRole.includes('agent')) return false;
  const content = contentRecord(message.content);
  const deliveryState = typeof content.deliveryState === 'string'
    ? content.deliveryState.trim().toLowerCase()
    : '';
  const status = message.status.trim().toLowerCase();
  const terminal = ['complete', 'completed', 'succeeded', 'responded', 'failed', 'cancelled', 'canceled'];
  return terminal.includes(deliveryState) || terminal.includes(status);
}

export function terminalLocalSelfAgentRequestClientMessageIds(
  state: CanonicalSessionState | null | undefined,
): Set<string> {
  if (!state) return new Set();
  const sessionIds = cloudSyncedLocalAgentSessionIds(state);
  const clientMessageIds = new Set<string>();
  for (const sessionId of sessionIds) {
    const messages = state.messages
      .filter((message) => message.sessionId === sessionId)
      .sort((left, right) => left.sequenceNum - right.sequenceNum || left.createdAtMs - right.createdAtMs);
    const localUsersById = new Map(messages.flatMap((message) => (
      message.senderRole === 'user' && !message.sourceTransport?.startsWith('cloud-')
        ? [[message.id, message] as const]
        : []
    )));
    let latestLocalUserId: string | null = null;
    for (const message of messages) {
      if (localUsersById.has(message.id)) {
        latestLocalUserId = message.id;
        continue;
      }
      if (!terminalLocalAgentMessage(message)) continue;
      const content = contentRecord(message.content);
      const explicitRequestId = [
        message.parentMessageId,
        typeof content.replyToMessageId === 'string' ? content.replyToMessageId : null,
        typeof content.requestId === 'string' ? content.requestId : null,
      ].find((value) => value?.trim() && localUsersById.has(value.trim()))?.trim();
      const requestId = explicitRequestId || latestLocalUserId;
      if (requestId) {
        clientMessageIds.add(cloudSelfAgentRequestClientMessageId(sessionId, requestId));
      }
    }
  }
  return clientMessageIds;
}

export function pendingCloudSelfAgentExecutionRequests({
  account,
  messageIndex,
  ignoredClientMessageIds = new Set(),
  nowMs = Date.now(),
}: {
  account: CloudAccount;
  messageIndex: CloudMessageIndex;
  ignoredClientMessageIds?: ReadonlySet<string>;
  nowMs?: number;
}): CloudMessage[] {
  const selfMessages = messageIndex.byPeerId.get(account.accountId) ?? [];
  return selfMessages.filter((message) => {
    if (!cloudMessageIsSelfAgentRequest(message, account)) return false;
    if (message.clientMessageId && ignoredClientMessageIds.has(message.clientMessageId)) return false;
    if (!cloudMessageActionAllowsAgentTrigger(
      cloudDirectMessageAction(message.body),
    )) return false;
    const createdAtMs = Date.parse(message.createdAt);
    if (
      !Number.isFinite(createdAtMs)
      || nowMs - createdAtMs > CLOUD_SELF_AGENT_LOCAL_EXECUTION_WINDOW_MS
    ) return false;
    if (!message.sessionId?.trim()) return false;
    if (cloudSelfAgentHasTerminalResponse(message.messageId, selfMessages)) {
      return false;
    }
    return !selfMessages.some(
      (candidate) => parseCloudAgentCancel(candidate.body)?.requestId
        === message.messageId,
    );
  });
}

export function cloudSelfAgentExecutionCanStart({
  account,
  initialMessagesSettled,
  runtimeReady,
}: {
  account: CloudAccount | null;
  initialMessagesSettled: boolean;
  runtimeReady: boolean;
}) {
  return Boolean(account && initialMessagesSettled && runtimeReady);
}
