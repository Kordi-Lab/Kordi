import type { Message, MessageActionSource, QueuedDesktopChatMessage } from '@/kordi-app/types';

export type MessageThread = {
  root: Message;
  replies: Message[];
};

function messageId(message: Message) {
  return message.id?.trim() || message.entryId?.trim() || message.turn?.id.trim() || '';
}

function messageIds(message: Message) {
  const replyTargetIds = new Set([
    message.replyToMessageId?.trim(),
    message.turn?.replyToMessageId?.trim(),
  ].filter(Boolean));
  return [...new Set([messageId(message), ...(message.replyAliasIds ?? [])]
    .map((id) => id.trim())
    .filter((id) => Boolean(id) && !replyTargetIds.has(id)))];
}

function messageHasVisibleContent(message: Message) {
  return Boolean(
    message.role === 'system'
    || message.role === 'action'
    || message.role === 'edit'
    || message.turn
    || message.callActivity
    || message.text.trim()
    || message.voiceMessage
    || message.attachments?.length
    || message.detail?.trim()
    || message.sourceMessage
    || message.supportContactTyping
    || message.messageAction?.kind === 'forward'
    || message.replySummary
    || message.threadSummary?.replyCount,
  );
}

export function threadRootMessageId(message: Message) {
  if (message.messageAction?.kind !== 'thread') return null;
  return message.messageAction.source.sourceMessageId.trim() || null;
}

export function threadRootSource(message: Message, sessionId: string): MessageActionSource | null {
  if (message.messageAction?.kind === 'thread') return message.messageAction.source;
  const sourceMessageId = messageId(message);
  if (!sourceMessageId || !sessionId.trim()) return null;
  return {
    sourceSessionId: sessionId,
    sourceMessageId,
    sourceMessageKind: message.turn ? 'agent-turn' : 'text',
    senderLabel: message.sender?.trim() || (message.isOwnMessage ? 'You' : 'Message'),
    textPreview: message.turn?.assistantText?.trim() || message.text.trim() || message.detail?.trim() || '',
    mentions: message.mentions,
    attachmentCount: message.attachments?.length ?? 0,
    createdAtMs: message.timestampMs ?? null,
    timeLabel: message.time?.trim() || null,
  };
}

export function projectMessageThreads(messages: readonly Message[]) {
  const roots = new Map<string, Message>();
  const primaryIdByAlias = new Map<string, string>();
  const replies = new Map<string, Message[]>();
  const rootIdByThreadMessageId = new Map<string, string>();
  const resolvingMessageIds = new Set<string>();
  const appendingMessageIds = new Set<string>();
  const appendedMessageIds = new Set<string>();

  messages.forEach((message) => {
    const id = messageId(message);
    if (!id) return;
    roots.set(id, message);
    messageIds(message).forEach((alias) => primaryIdByAlias.set(alias, id));
  });

  const resolveThreadRootId = (message: Message): string | null => {
    const ids = messageIds(message);
    const cached = ids.map((id) => rootIdByThreadMessageId.get(id)).find(Boolean);
    if (cached) return cached;
    const id = messageId(message);
    if (!id || resolvingMessageIds.has(id)) return null;
    resolvingMessageIds.add(id);
    const explicitRootAlias = threadRootMessageId(message);
    const explicitRootId = explicitRootAlias
      ? primaryIdByAlias.get(explicitRootAlias) ?? explicitRootAlias
      : null;
    const parentAlias = message.replyToMessageId?.trim() || message.turn?.replyToMessageId?.trim();
    const parentId = parentAlias ? primaryIdByAlias.get(parentAlias) ?? parentAlias : null;
    const parent = parentId ? roots.get(parentId) : null;
    const rootId = explicitRootId || (parent ? resolveThreadRootId(parent) : null);
    resolvingMessageIds.delete(id);
    if (rootId) ids.forEach((candidate) => rootIdByThreadMessageId.set(candidate, rootId));
    return rootId;
  };

  const appendThreadMessage = (message: Message) => {
    const id = messageId(message);
    if (!id || appendedMessageIds.has(id) || appendingMessageIds.has(id)) return;
    const rootId = resolveThreadRootId(message);
    if (!rootId) return;
    appendingMessageIds.add(id);
    const parentAlias = message.replyToMessageId?.trim() || message.turn?.replyToMessageId?.trim();
    const parentId = parentAlias ? primaryIdByAlias.get(parentAlias) ?? parentAlias : null;
    const parent = parentId ? roots.get(parentId) : null;
    if (parent && resolveThreadRootId(parent) === rootId) appendThreadMessage(parent);
    appendingMessageIds.delete(id);
    appendedMessageIds.add(id);
    if (!messageHasVisibleContent(message)) return;
    const current = replies.get(rootId);
    if (current) current.push(message);
    else replies.set(rootId, [message]);
  };
  messages.forEach(appendThreadMessage);

  const threads = new Map<string, MessageThread>();
  replies.forEach((threadReplies, rootId) => {
    const root = roots.get(rootId);
    if (root) threads.set(rootId, { root, replies: threadReplies });
  });

  return {
    mainMessages: messages
      .filter((message) => !messageIds(message).some((id) => rootIdByThreadMessageId.has(id)))
      .filter(messageHasVisibleContent)
      .map((message) => {
        const count = replies.get(messageId(message))?.length ?? 0;
        return count > 0 ? { ...message, threadSummary: { replyCount: count } } : message;
    }),
    threads,
    threadRootIdByMessageId: rootIdByThreadMessageId,
  };
}

export function messagesWithThreadReplyCounts(
  messages: readonly Message[],
  conversationId: string,
  liveThreadRootId?: string | null,
  optimisticConversationId?: string,
  optimisticThreadRootId?: string,
  optimisticReplyCount?: number,
) {
  return messages.map((message) => {
    const ids = [message.id, message.entryId, ...(message.replyAliasIds ?? [])]
      .map((id) => id?.trim())
      .filter(Boolean);
    const actualCount = message.threadSummary?.replyCount ?? 0;
    const optimisticCount = optimisticReplyCount
      && optimisticConversationId === conversationId
      && optimisticThreadRootId
      && ids.includes(optimisticThreadRootId)
      ? optimisticReplyCount
      : 0;
    const liveCount = liveThreadRootId && ids.includes(liveThreadRootId) ? 1 : 0;
    const replyCount = Math.max(optimisticCount, actualCount + liveCount);
    return replyCount !== actualCount ? { ...message, threadSummary: { replyCount } } : message;
  });
}

export function projectQueuedThreadMessages(
  messages: readonly QueuedDesktopChatMessage[],
  activeThreadRootId?: string | null,
) {
  return {
    mainMessages: messages.filter((message) => message.messageAction?.kind !== 'thread'),
    activeThreadMessages: activeThreadRootId
      ? messages.filter((message) => (
          message.messageAction?.kind === 'thread'
          && message.messageAction.source.sourceMessageId === activeThreadRootId
        ))
      : [],
  };
}
