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

export function localSelfAgentRequestClientMessageIds(
  state: CanonicalSessionState | null | undefined,
): Set<string> {
  if (!state) return new Set();
  const sessionIds = cloudSyncedLocalAgentSessionIds(state);
  return new Set(state.messages.flatMap((message) => (
    sessionIds.has(message.sessionId)
    && message.senderRole === 'user'
    && !message.sourceTransport?.startsWith('cloud-')
      ? [cloudSelfAgentRequestClientMessageId(message.sessionId, message.id)]
      : []
  )));
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
