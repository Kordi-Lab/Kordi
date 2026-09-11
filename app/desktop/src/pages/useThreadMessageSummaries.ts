import type {Conversation,Message,DesktopChatTurnSnapshot} from '@/kordi-app/types';
import {suppressLiveTurnEchoMessages} from '@/app/viewModels/helpers';
import {collapseAdjacentSessionConfigNotices} from '@/features/chat/sessionConfigNotices';
import {buildReplyAttribution,shouldInferLatestHumanReplyTarget} from '@/features/chat/replyAttribution';
import {transcriptMessageNavigationIds} from '@/features/chat/transcriptMessageIdentity';
import { useMemo } from 'react';
import { messagesWithThreadReplyCounts, projectMessageThreads, resolveThreadMessageId, type MessageThread } from '@/features/chat/messageThreads';
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

export function useThreadTranscript(conversation:Conversation, activeTranscriptLiveTurn:DesktopChatTurnSnapshot|undefined, notificationMessage?:Message, loadedThread?: MessageThread) {
  const transcriptMessages = useMemo(
    () => collapseAdjacentSessionConfigNotices(
      suppressLiveTurnEchoMessages(notificationMessage && !conversation.messages.some(message=>transcriptMessageNavigationIds(message).includes(notificationMessage.id!))
        ? [...conversation.messages,notificationMessage].sort((a,b)=>(a.conversationSequence??0)-(b.conversationSequence??0)) : conversation.messages, activeTranscriptLiveTurn),
    ),
    [conversation.messages, activeTranscriptLiveTurn, notificationMessage],
  );
  const inferLatestHumanRequest = shouldInferLatestHumanReplyTarget(conversation);
  const locatedTranscript = useMemo(
    () => buildReplyAttribution(transcriptMessages, activeTranscriptLiveTurn, {
      inferLatestHumanRequest,
    }),
    [activeTranscriptLiveTurn, inferLatestHumanRequest, transcriptMessages],
  );
  const locatedLiveTurn = locatedTranscript.liveTurn ?? activeTranscriptLiveTurn;
  const threadProjection = useMemo(
    () => projectMessageThreads(locatedTranscript.messages, loadedThread ? [loadedThread.root, ...loadedThread.replies] : []),
    [locatedTranscript.messages, loadedThread],
  );
  return {threadProjection,locatedLiveTurn};
}

export function useActiveThread(rootMessageId:string|null,projection:ReturnType<typeof projectMessageThreads>,messages:Message[]) {
  return useMemo(() => {
    if (!rootMessageId) return null;
    const rootId = resolveThreadMessageId(rootMessageId, projection.primaryIdByAlias);
    const existing = projection.threads.get(rootId);
    if (existing) return existing;
    const root = messages.find((message) => (
      message.id === rootId || message.entryId === rootId
    ));
    return root ? { root, replies: [] } : null;
  }, [rootMessageId, messages, projection.primaryIdByAlias, projection.threads]);
}
