import { useMemo } from 'react';

import {
  buildForkLineage,
} from '@/features/chat/forkLineage';
import { LOCAL_DRAFT_CHAT_CONVERSATION_ID } from '@/features/chat/draftSessions';
import type {
  Conversation,
  DesktopChatState,
  Message,
} from '@/kordi-app/types';
import {
  forkSnapshotBoundaryIndexForMessages,
  forkSourceMessageIds,
} from '@/pages/chatsPage.model';

type UseChatForkModelInput = {
  conversation: Conversation;
  messages: readonly Message[];
  desktopChatState: DesktopChatState | null;
  isGroupSession: boolean;
  isAgentSession: boolean;
  onForkMessage?: (sessionId: string, messageEntryId: string) => Promise<void>;
};

type ForkSummary = {
  sessionId: string;
  title: string;
  updatedAtLabel?: string;
};

export function useChatForkModel({
  conversation,
  messages,
  desktopChatState,
  isGroupSession,
  isAgentSession,
  onForkMessage,
}: UseChatForkModelInput) {
  const sourceSessionId = conversation.forkedFromSessionId?.trim() || null;
  const sourceMessageIds = useMemo(
    () => forkSourceMessageIds(conversation),
    [conversation],
  );
  const sourceTitle = useMemo(() => {
    if (!sourceSessionId) return null;
    const summary = desktopChatState?.sessions.find(
      (session) => session.id === sourceSessionId,
    );
    return summary?.title || 'previous session';
  }, [desktopChatState?.sessions, sourceSessionId]);

  const forksByEntryId = useMemo(() => {
    if (isGroupSession) return new Map<string, ForkSummary[]>();
    const summaries = desktopChatState?.sessions ?? [];
    const lineage = buildForkLineage(summaries.map((summary) => ({
      id: summary.id,
      forkedFromSessionId: summary.forkedFromSessionId ?? null,
      forkedFromMessageId: summary.forkedFromMessageId ?? null,
    })));
    const forksAtMessage = lineage.forksByParentMessageIdBySession.get(conversation.id);
    if (!forksAtMessage) return new Map<string, ForkSummary[]>();
    const summaryById = new Map(summaries.map((summary) => [summary.id, summary]));
    const result = new Map<string, ForkSummary[]>();
    for (const [messageId, forks] of forksAtMessage) {
      const entries = forks
        .map((fork) => summaryById.get(fork.id))
        .filter((summary): summary is NonNullable<typeof summary> => Boolean(summary))
        .map((summary) => ({
          sessionId: summary.id,
          title: summary.title || 'Untitled fork',
          updatedAtLabel: summary.updatedAtLabel,
        }));
      if (entries.length > 0) result.set(messageId, entries);
    }
    return result;
  }, [conversation.id, desktopChatState?.sessions, isGroupSession]);

  const snapshotBoundaryIndex = useMemo(() => {
    if (!sourceSessionId) return -1;
    return forkSnapshotBoundaryIndexForMessages(messages, sourceMessageIds);
  }, [messages, sourceMessageIds, sourceSessionId]);

  const isForkable = Boolean(
    onForkMessage
      && conversation.id
      && conversation.id !== LOCAL_DRAFT_CHAT_CONVERSATION_ID
      && !conversation.id.startsWith('bridge:')
      && !isGroupSession
      && isAgentSession,
  );
  const forkMessage = isForkable && onForkMessage
    ? (entryId: string) => {
        void onForkMessage(conversation.id, entryId);
      }
    : undefined;

  return {
    sourceSessionId,
    sourceTitle,
    forksByEntryId,
    snapshotBoundaryIndex,
    forkMessage,
  };
}
