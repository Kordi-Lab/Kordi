import type { CanonicalSessionMessage } from '@/kordi-app/types';
import { fetchCanonicalSessionMessages } from '@/lib/desktop';
import type {
  ChatSyncConversation,
  ChatSyncMessage,
  CloudAuthClient,
} from './authClient';

export async function loadCanonicalRecoveryMessages(
  sessionIds: ReadonlySet<string>,
  shouldContinue: () => boolean,
) {
  const pages = await Promise.all([...sessionIds].map(async (sessionId) => {
    const messages: CanonicalSessionMessage[] = [];
    let beforeSequenceNum: number | null = null;
    let pageCount = 0;
    do {
      if (!shouldContinue()) return [];
      const page = await fetchCanonicalSessionMessages(sessionId, beforeSequenceNum, 200);
      if (!page) return [];
      messages.push(...page.messages);
      if (!page.hasOlder || page.oldestSequenceNum === null) break;
      beforeSequenceNum = page.oldestSequenceNum;
      pageCount += 1;
      if (pageCount >= 10_000) {
        throw new Error('Canonical agent history pagination did not finish.');
      }
    } while (true);
    return messages;
  }));
  return pages.flat();
}

export async function loadRemoteRecoveryMessages(
  client: CloudAuthClient,
  token: string,
  conversations: readonly ChatSyncConversation[],
  sessionIds: ReadonlySet<string>,
  shouldContinue: () => boolean,
): Promise<ChatSyncMessage[]> {
  const conversationBySessionId = new Map(conversations.map((conversation) => [
    conversation.legacy_session_id ?? conversation.id,
    conversation,
  ]));
  const pages = await Promise.all([...sessionIds].map(async (sessionId) => {
    const conversation = conversationBySessionId.get(sessionId);
    if (!conversation || conversation.latest_message_sequence === 0) return [];
    const messages: ChatSyncMessage[] = [];
    let beforeSequence: number | undefined;
    let pageCount = 0;
    do {
      if (!shouldContinue()) return [];
      const page = await client.listChatConversationHistoryPage(
        token,
        conversation.id,
        beforeSequence,
        200,
      );
      messages.push(...page.messages);
      if (!page.hasMore || page.nextBeforeSequence === null) break;
      beforeSequence = page.nextBeforeSequence;
      pageCount += 1;
      if (pageCount >= 10_000) {
        throw new Error('Remote agent history pagination did not finish.');
      }
    } while (true);
    return messages;
  }));
  return pages.flat();
}
