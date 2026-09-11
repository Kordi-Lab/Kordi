import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CloudAuthClient } from '@/features/cloud/authClient';
import { loadSession } from '@/features/cloud/session';
import { threadMessage, useThreadNavigation } from '@/features/cloud/threadAttention';
import type { Conversation } from '@/kordi-app/types';
import type { MessageThread } from '@/features/chat/messageThreads';
import { mergeThreadReplies } from '@/features/chat/threadReplies';

type LoadedThread = {
  scope: string;
  thread: MessageThread;
  first: string | null;
  target: string | null;
  next: number | null;
  isThread: boolean;
};

export function useUnreadThreadNavigation(
  conversation: Conversation,
  accountId: string | undefined,
  open: (rootId: string) => void,
  activeRootId: string | null,
) {
  const request = useThreadNavigation();
  const scope = `${accountId}:${conversation.id}`;
  const scopeRef = useRef(scope);
  const generation = useRef(0);
  useLayoutEffect(() => { if (scopeRef.current !== scope) { scopeRef.current = scope; generation.current += 1; } }, [scope]);
  const [result, setResult] = useState<LoadedThread | null>(null);
  const [status, setStatus] = useState<{ scope: string; busy: boolean; error: string | null } | null>(null);
  const lastRequest = useRef('');
  const lastTarget = useRef<{ messageId: string; after?: number } | null>(null);

  const load = useCallback(async (messageId?: string, after?: number) => {
    const target = messageId ?? conversation.threadAttention?.next_message_id;
    if (!accountId || !target) return;
    lastTarget.current = { messageId: target, after };
    const attempt = ++generation.current;
    setStatus({ scope, busy: true, error: null });
    try {
      const session = await loadSession();
      if (session?.accountId !== accountId) return;
      const page = await new CloudAuthClient().chat.threadPage(
        session.token, conversation.canonicalSessionId ?? conversation.id, target, after,
      );
      if (scopeRef.current !== scope || generation.current !== attempt || (await loadSession())?.accountId !== accountId) return;
      const root = threadMessage(page.root, conversation, accountId);
      const replies = page.messages.map(message => threadMessage(message, conversation, accountId));
      setResult(current => ({
        scope,
        thread: {
          root,
          replies: after !== undefined && current?.scope === scope && current.thread.root.id === root.id
            ? mergeThreadReplies(current.thread.replies, replies) : replies,
        },
        first: after !== undefined ? current?.first ?? null : page.firstUnreadMessageId,
        target: after !== undefined ? replies[0]?.id ?? null : page.firstUnreadMessageId ?? (page.isThread ? target : null),
        next: page.nextAfterSequence,
        isThread: page.isThread,
      }));
      if (page.isThread) open(root.id!);
    } catch {
      if (scopeRef.current === scope && generation.current === attempt) {
        setStatus({ scope, busy: false, error: 'Could not open this discussion. Retry, or return to the chat.' });
      }
    } finally {
      if (scopeRef.current === scope && generation.current === attempt) {
        setStatus(current => current?.scope === scope ? { ...current, busy: false } : current);
      }
    }
  }, [accountId, conversation, open, scope]);

  useEffect(() => {
    if (!request || ![conversation.id, conversation.canonicalSessionId].includes(request.sessionId)) return;
    const key = `${scope}:${request.nonce}`;
    if (lastRequest.current === key) return;
    lastRequest.current = key;
    void load(request.messageId);
  }, [conversation.id, conversation.canonicalSessionId, load, request, scope]);

  const page = result?.scope === scope ? result : null;
  const tail = page?.thread.replies[page.thread.replies.length - 1]?.conversationSequence;
  useEffect(() => {
    if (!page?.isThread || page.thread.root.id !== activeRootId || page.next !== null || !accountId || tail == null) return;
    let cancelled = false;
    let running = false;
    const client = new CloudAuthClient();
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      void (async () => {
        try {
          const session = await loadSession();
          if (session?.accountId !== accountId) return;
          const incoming = await client.chat.threadPage(session.token, conversation.canonicalSessionId ?? conversation.id, activeRootId, tail);
          if (cancelled || incoming.messages.length === 0 || (await loadSession())?.accountId !== accountId) return;
          const replies = incoming.messages.map(message => threadMessage(message, conversation, accountId));
          setResult(previous => previous?.scope === scope && previous.thread.root.id === activeRootId ? {
            ...previous,
            thread: { ...previous.thread, replies: mergeThreadReplies(previous.thread.replies, replies) },
            next: incoming.nextAfterSequence,
          } : previous);
        } catch { /* Preserve the open thread during reconnect. */ }
        finally { running = false; }
      })();
    }, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [accountId, activeRootId, conversation, page, scope, tail]);

  const merge = (thread: MessageThread | null): MessageThread | null => {
    if (!page?.isThread || !thread || (thread.root.reactionTargetMessageId ?? thread.root.id)
      !== (page.thread.root.reactionTargetMessageId ?? page.thread.root.id)) return thread;
    return { root: thread.root, replies: mergeThreadReplies(page.thread.replies, thread.replies) };
  };
  return {
    page, load, merge,
    busy: status?.scope === scope && status.busy,
    error: status?.scope === scope ? status.error : null,
    retry: () => load(lastTarget.current?.messageId, lastTarget.current?.after),
  };
}
