import { useMemo } from 'react';
import { messagesWithThreadReplyCounts, type projectMessageThreads } from '@/features/chat/messageThreads';
import { threadHasUnread } from '@/features/chat/threadReadState';
import type { useChatThreadSelection } from './useChatThreadSelection';

export function useThreadMessageSummaries(
  projection: ReturnType<typeof projectMessageThreads>,
  reads: Record<string, number> | null,
  conversationId: string,
  activeRootId: string | null,
  openThread: ReturnType<typeof useChatThreadSelection>['openThreadState'],
) {
  const optimisticConversationId = openThread?.conversationId;
  const optimisticRootId = openThread?.rootId;
  const optimisticReplyCount = openThread?.optimisticReplyCount;
  return useMemo(() => messagesWithThreadReplyCounts(
    projection.mainMessages.map(message => {
      const thread = projection.threads.get(message.id ?? '');
      return thread && message.threadSummary && reads
        ? { ...message, threadSummary: { ...message.threadSummary, unread: threadHasUnread(thread, reads) } }
        : message;
    }),
    conversationId, activeRootId, optimisticConversationId, optimisticRootId, optimisticReplyCount,
  ), [projection.mainMessages, projection.threads, reads, conversationId, activeRootId, optimisticConversationId, optimisticRootId, optimisticReplyCount]);
}
