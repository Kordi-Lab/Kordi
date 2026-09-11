import type { Message } from '@/kordi-app/types';
import type { CloudThreadRead } from '@/features/cloud/chatSyncTypes';
import type { MessageThread } from './messageThreads';
import { transcriptMessageNavigationIds } from './transcriptMessageIdentity';

export function threadUnreadMarkerMessageId(
  thread: MessageThread,
  initialMessageId: string | null | undefined,
  reads: Record<string, number> | null | undefined,
): string | null {
  if (!initialMessageId) return null;
  const key = threadReadKey(thread.root);
  if (!key || !reads) return initialMessageId;
  const message = thread.replies.find(reply => transcriptMessageNavigationIds(reply).includes(initialMessageId));
  const sequence = message?.conversationSequence;
  if (typeof sequence === 'number' && sequence > 0 && (reads[key] ?? 0) >= sequence) return null;
  return initialMessageId;
}

export function threadReadKey(root: Message): string | null {
  const key = root.reactionTargetMessageId;
  return key && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key) ? key.toLowerCase() : null;
}

export function mergeThreadReads(current: Record<string, number>, reads: CloudThreadRead[]) {
  let next = current;
  for (const read of reads) {
    for (const key of [read.root_message_id, read.root_client_message_id]) {
      if (read.last_read_sequence <= (next[key] ?? -1)) continue;
      if (next === current) next = {...current};
      next[key] = read.last_read_sequence;
    }
  }
  return next;
}

export function threadHasUnread(thread: MessageThread, reads: Record<string, number>) {
  const key = threadReadKey(thread.root);
  if (!key) return false;
  return thread.replies.some(message => message.role !== 'user' && !message.isOwnMessage
    && (message.conversationSequence ?? 0) > (reads[key] ?? 0));
}
