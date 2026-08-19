import type { CloudMessage } from './authClient';
import {
  isCloudAgentControlMessage,
  parseCloudAgentResponse,
} from './cloudAgentMessages';
import { cloudSelfAgentProcessingTextWouldRegress } from './cloudSelfAgentResponseLifecycle';
import { compareCloudMessages } from './cloudMessageMerge';

export function selectVisibleCloudAgentResponses(
  messages: readonly CloudMessage[],
  requestTargetAccountIds: ReadonlyMap<string, string>,
  isGroupControlMessage: (message: CloudMessage) => boolean,
  hasCompletedLocalResponse: (requestId: string) => boolean,
) {
  const preferredResponseByKey = new Map<string, CloudMessage>();
  for (const message of messages) {
    const response = parseCloudAgentResponse(message.body);
    if (!response) continue;
    const expectedResponder = requestTargetAccountIds.get(response.requestId);
    if (expectedResponder && message.fromAccountId !== expectedResponder) {
      continue;
    }
    const responderAccountId = expectedResponder || message.fromAccountId;
    const responseKey = `${response.requestId}:${responderAccountId}`;
    const existing = preferredResponseByKey.get(responseKey);
    if (!existing) {
      preferredResponseByKey.set(responseKey, message);
      continue;
    }
    const existingResponse = parseCloudAgentResponse(existing.body);
    const existingIsTerminal = existingResponse
      ?.deliveryState !== 'processing';
    const candidateIsTerminal = response.deliveryState !== 'processing';
    if (existingIsTerminal && !candidateIsTerminal) continue;
    if (
      !existingIsTerminal
      && !candidateIsTerminal
      && cloudSelfAgentProcessingTextWouldRegress(
        existingResponse?.text ?? '',
        response.text,
      )
    ) continue;
    if (
      (!existingIsTerminal && candidateIsTerminal)
      || compareCloudMessages(existing, message) <= 0
    ) preferredResponseByKey.set(responseKey, message);
  }

  const selectedMessages = messages.filter((message) => {
    if (isCloudAgentControlMessage(message.body) || isGroupControlMessage(message)) {
      return false;
    }
    const response = parseCloudAgentResponse(message.body);
    if (!response) return true;
    const expectedResponder = requestTargetAccountIds.get(response.requestId);
    if (expectedResponder && message.fromAccountId !== expectedResponder) {
      return false;
    }
    const responderAccountId = expectedResponder || message.fromAccountId;
    const responseKey = `${response.requestId}:${responderAccountId}`;
    return preferredResponseByKey.get(responseKey)?.messageId
      === message.messageId;
  });
  const responseRequestIds = new Set<string>();
  const terminalResponseRequestIds = new Set<string>();
  const visibleMessages = selectedMessages.filter((message) => {
    const response = parseCloudAgentResponse(message.body);
    if (!response) return true;
    responseRequestIds.add(response.requestId);
    if (response.deliveryState !== 'processing') {
      terminalResponseRequestIds.add(response.requestId);
      return true;
    }
    return !hasCompletedLocalResponse(response.requestId);
  });
  return { visibleMessages, responseRequestIds, terminalResponseRequestIds };
}

export function latestVisibleConversationMessage<T extends {
  messageKind?: string | null;
}>(messages: readonly T[]): T | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.messageKind !== 'agent-model-change') return message ?? null;
  }
  return null;
}
