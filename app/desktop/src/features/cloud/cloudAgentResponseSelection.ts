import type { CloudMessage } from './authClient';
import {
  isCloudAgentControlMessage,
  parseCloudAgentResponse,
} from './cloudAgentMessages';
import { compareCloudMessages } from './cloudMessageMerge';

export function visibleCloudAgentResponseMessages(
  messages: readonly CloudMessage[],
  requestTargetAccountIds: ReadonlyMap<string, string>,
  isGroupControlMessage: (message: CloudMessage) => boolean,
): CloudMessage[] {
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
    const existingIsTerminal = parseCloudAgentResponse(existing.body)
      ?.deliveryState !== 'processing';
    const candidateIsTerminal = response.deliveryState !== 'processing';
    if (existingIsTerminal && !candidateIsTerminal) continue;
    if (
      (!existingIsTerminal && candidateIsTerminal)
      || compareCloudMessages(existing, message) <= 0
    ) preferredResponseByKey.set(responseKey, message);
  }

  return messages.filter((message) => {
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
