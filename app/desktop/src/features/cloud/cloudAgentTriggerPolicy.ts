import type { MessageActionMetadata } from '@/kordi-app/types/message';
import { projectMessageThreads } from '@/features/chat/messageThreads';

export function cloudAgentContextMessageIds(
  messages: readonly {
    id: string;
    replyToMessageId?: string | null;
    replyAliasIds?: string[];
    messageAction?: MessageActionMetadata | null;
  }[],
  requestId: string,
  replyAction?: MessageActionMetadata | null,
): Set<string> {
  const projection = projectMessageThreads(messages.map((message) => ({
    ...message,
    role: 'person' as const,
    text: 'Context message',
    time: '',
    messageAction: (message.id === requestId ? replyAction ?? message.messageAction : message.messageAction) ?? undefined,
  })));
  const roots = projection.threadRootIdByMessageId;
  const requestRoot = roots.get(requestId) ?? null;
  const knownIds = new Set(messages.flatMap((message) => [message.id, ...(message.replyAliasIds ?? [])]));
  return new Set(messages.filter((message) => (
    !(message.replyToMessageId && !knownIds.has(message.replyToMessageId) && !message.messageAction)
    && (
      (roots.get(message.id) ?? null) === requestRoot
      || message.id === requestRoot
      || (requestRoot != null && message.replyAliasIds?.includes(requestRoot))
    )
  )).map((message) => message.id));
}

/**
 * Forwarding copies existing content into another conversation. Mentions in
 * that copied content are display-only and must not be interpreted as a new
 * request to an agent or included as a later model turn. Quotes remain
 * eligible because the user can add a new prompt alongside quoted context.
 */
function cloudMessageActionIsForward(
  messageAction: MessageActionMetadata | null | undefined,
): boolean {
  return messageAction?.kind === 'forward';
}

export function cloudMessageActionAllowsAgentTrigger(
  messageAction: MessageActionMetadata | null | undefined,
): boolean {
  return !cloudMessageActionIsForward(messageAction);
}

export function cloudMessageActionAllowsAgentContext(
  messageAction: MessageActionMetadata | null | undefined,
): boolean {
  return !cloudMessageActionIsForward(messageAction);
}
