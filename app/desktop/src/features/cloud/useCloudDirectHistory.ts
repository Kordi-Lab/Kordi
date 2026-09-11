import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  cloudConversationKindFromConversationId,
  cloudDirectPersonSessionId,
  cloudPeerAccountIdFromConversationId,
  cloudSessionIdFromConversationId,
} from '@/features/collaboration/conversationIds';
import { isNativeDesktopShell } from '@/lib/desktop';
import { applyChatSyncLocalBatch, CHAT_SYNC_LOCAL_STATE_CHANGED_EVENT, loadChatSyncConversations, loadChatSyncCoverage, loadChatSyncMessagesPage } from '@/lib/desktopChatSync';
import type { CloudAccount, CloudAuthClient, CloudMessage } from './authClient';
import { cloudMessageFromChatSync } from './chatSyncMapping';
import { cloudMessageMetadataOnly } from './cloudMessageCache';
import { cloudMessageDeletions } from './cloudMessageDeletions';
import { mergeCloudMessagesByPeerSnapshot } from './cloudMessageSyncState';
import { loadSession } from './session';

export const DIRECT_HISTORY_PAGE_SIZE = 50;
export type CloudDirectHistoryPage = {
  sessionId: string;
  messagesByPeer: Record<string, CloudMessage[]>;
  beforeSequence: number | null;
  hasOlder: boolean;
};

export function directHistorySessionId(accountId: string, conversationId: string | null | undefined) {
  if (!conversationId) return null;
  if (conversationId.startsWith('session:direct-person:')) return conversationId;
  if (cloudConversationKindFromConversationId(conversationId) !== 'person') return null;
  const peerId = cloudPeerAccountIdFromConversationId(conversationId);
  if (!peerId || peerId === accountId) return null;
  const sessionId = cloudDirectPersonSessionId(accountId, peerId);
  const explicit = cloudSessionIdFromConversationId(conversationId);
  return !explicit || explicit === sessionId ? sessionId : null;
}

export async function readDirectCloudHistoryPage(
  accountId: string,
  sessionId: string,
  client: CloudAuthClient,
  beforeSequence?: number,
): Promise<CloudDirectHistoryPage | null> {
  const conversations = await loadChatSyncConversations(accountId);
  const conversation = conversations.find((row) => row.kind === 'direct'
    && (row.legacy_session_id ?? row.id) === sessionId
    && row.members.some((member) => member.account_id === accountId));
  if (!conversation) return null;
  const coverage = (await loadChatSyncCoverage(accountId)).find((row) => row.conversationId === conversation.id);
  const before = beforeSequence ?? conversation.latest_message_sequence + 1;
  // A complete contiguous local history can serve a reverse page through the
  // existing ascending native API. Gaps/deletions use the server cursor API.
  const localComplete = coverage?.earliestSequence === 1
    && coverage.latestSequence === conversation.latest_message_sequence
    && coverage.messageCount === coverage.latestSequence;
  let page;
  if (localComplete) {
    const after = Math.max(0, before - DIRECT_HISTORY_PAGE_SIZE - 1);
    const local = await loadChatSyncMessagesPage(accountId, conversation.id, after, Math.min(DIRECT_HISTORY_PAGE_SIZE, before - 1));
    if (!local) throw new Error('Local direct conversation history is unavailable.');
    const messages = (local?.messages ?? []).filter((row) => row.conversation_sequence < before);
    const oldest = messages.reduce((min, row) => Math.min(min, row.conversation_sequence), before);
    page = { messages, nextBeforeSequence: messages.length ? oldest : null, hasMore: oldest > 1 && messages.length > 0 };
  } else {
    const session = await loadSession();
    if (!session?.token || session.accountId !== accountId) return null;
    page = await client.listChatConversationHistoryPage(session.token, conversation.id, beforeSequence, DIRECT_HISTORY_PAGE_SIZE);
    await applyChatSyncLocalBatch({ accountId, bootstrap: false, conversations: [conversation], messages: page.messages });
  }
  const messagesByPeer: Record<string, CloudMessage[]> = {};
  for (const snapshot of page.messages) {
    const message = cloudMessageMetadataOnly(cloudMessageFromChatSync(snapshot, conversation, accountId));
    const peerId = message.fromAccountId === accountId ? message.toAccountId : message.fromAccountId;
    (messagesByPeer[peerId] ??= []).push(message);
  }
  return { sessionId, messagesByPeer, beforeSequence: page.nextBeforeSequence, hasOlder: page.hasMore };
}

export function useCloudDirectHistory(account: CloudAccount | null, activeConversationId: string | null | undefined, client: CloudAuthClient) {
  const accountId = account?.accountId ?? null;
  const sessionId = accountId && isNativeDesktopShell() ? directHistorySessionId(accountId, activeConversationId) : null;
  const key = accountId && sessionId ? `${accountId}\u0000${sessionId}` : '';
  const currentKey = useRef(key);
  const snapshotRef = useRef<({ key: string } & CloudDirectHistoryPage) | null>(null);
  const flightRef = useRef<{ key: string; promise: Promise<void> } | null>(null);
  const [snapshot, setSnapshot] = useState<typeof snapshotRef.current>(null);
  useLayoutEffect(() => { currentKey.current = key; }, [key]);

  const load = useCallback((older: boolean) => {
    if (!accountId || !sessionId || currentKey.current !== key) return Promise.resolve();
    if (flightRef.current?.key === key) return flightRef.current.promise;
    const previous = snapshotRef.current?.key === key ? snapshotRef.current : null;
    if (older && (!previous?.hasOlder || !previous.beforeSequence)) return Promise.resolve();
    const promise = readDirectCloudHistoryPage(accountId, sessionId, client, older ? previous!.beforeSequence! : undefined)
      .then((page) => {
        if (!page || currentKey.current !== key) return;
        if (older && page.hasOlder && (!page.beforeSequence || page.beforeSequence >= previous!.beforeSequence!)) {
          throw new Error('Direct conversation history cursor did not advance.');
        }
        const messagesByPeer = mergeCloudMessagesByPeerSnapshot(
          older && previous ? previous.messagesByPeer : {}, page.messagesByPeer, cloudMessageDeletions.ids(accountId),
        );
        const next = { ...page, messagesByPeer, key };
        snapshotRef.current = next;
        setSnapshot(next);
      }).finally(() => {
        if (flightRef.current?.promise === promise) flightRef.current = null;
      });
    flightRef.current = { key, promise };
    return promise;
  }, [accountId, client, key, sessionId]);

  useEffect(() => {
    currentKey.current = key;
    if (snapshotRef.current?.key !== key) {
      snapshotRef.current = null;
      queueMicrotask(() => {
        if (currentKey.current === key) setSnapshot((current) => current?.key === key ? current : null);
      });
    }
    if (!key) return;
    let refreshing = false;
    let refreshAgain = false;
    const refresh = () => {
      if (currentKey.current !== key) return;
      if (refreshing) { refreshAgain = true; return; }
      const previous = snapshotRef.current;
      if (previous?.key === key) {
        const messagesByPeer = cloudMessageDeletions.filter(accountId, previous.messagesByPeer);
        if (messagesByPeer !== previous.messagesByPeer) {
          const next = { ...previous, messagesByPeer };
          snapshotRef.current = next;
          setSnapshot(next);
        }
      } else {
        refreshing = true;
        void load(false).catch(() => {}).finally(() => {
          refreshing = false;
          if (refreshAgain) { refreshAgain = false; refresh(); }
        });
      }
    };
    refresh();
    window.addEventListener(CHAT_SYNC_LOCAL_STATE_CHANGED_EVENT, refresh);
    window.addEventListener('focus', refresh);
    return () => {
      if (currentKey.current === key) currentKey.current = '';
      window.removeEventListener(CHAT_SYNC_LOCAL_STATE_CHANGED_EVENT, refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [accountId, key, load]);

  const page = snapshot?.key === key ? snapshot : null;
  const hasOlderBySessionId = useMemo(() => page ? { [page.sessionId]: page.hasOlder } : {}, [page]);
  const loadOlderSessionMessages = useCallback((requestedSessionId: string) => requestedSessionId === sessionId ? load(true) : Promise.resolve(), [load, sessionId]);
  return { page, hasOlderBySessionId, loadOlderSessionMessages };
}
