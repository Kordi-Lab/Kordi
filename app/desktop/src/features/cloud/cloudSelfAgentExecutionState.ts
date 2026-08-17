import type { DesktopChatTurnSnapshot } from '@/kordi-app/types';
import type { CloudAccount, CloudMessage } from './authClient';
import {
  cloudMessageIsSelfAgentRequest,
  parseCloudAgentCancel,
  parseCloudAgentResponse,
} from './cloudAgentMessages';
import { cloudDirectMessageAction } from './cloudDirectMessages';
import { cloudMessageActionAllowsAgentTrigger } from './cloudAgentTriggerPolicy';
import type { CloudMessageIndex } from './cloudMessageIndex';

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

export function pendingCloudSelfAgentExecutionRequests({
  account,
  messageIndex,
  nowMs = Date.now(),
}: {
  account: CloudAccount;
  messageIndex: CloudMessageIndex;
  nowMs?: number;
}): CloudMessage[] {
  const selfMessages = messageIndex.byPeerId.get(account.accountId) ?? [];
  return selfMessages.filter((message) => {
    if (!cloudMessageIsSelfAgentRequest(message, account)) return false;
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
