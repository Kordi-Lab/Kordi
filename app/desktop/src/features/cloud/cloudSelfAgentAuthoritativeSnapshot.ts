import type { CloudMessage } from './authClient';

export type CloudSelfAgentAuthoritativeSnapshot = {
  accountId: string;
  messageIds: Set<string>;
} | null;

export function cloudSelfAgentAuthoritativeSnapshot(
  accountId: string,
  messages: CloudMessage[],
): Exclude<CloudSelfAgentAuthoritativeSnapshot, null> {
  return {
    accountId,
    messageIds: new Set(messages.map((message) => message.messageId)),
  };
}
