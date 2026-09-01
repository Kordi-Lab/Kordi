import {
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type {
  CanonicalSessionState,
} from '@/kordi-app/types';
import type {
  CloudAccount,
  CloudMessage,
} from './authClient';
import {
  patchCanonicalDeliverySummaries,
  type CloudMessageIndex,
} from './cloudMessageIndex';
import {
  cloudOptimisticallyReadSessionIds,
  cloudUnreadCountsBySessionId,
  mergeNativeCloudUnreadCounts,
  patchCanonicalCloudUnreadCounts,
} from './cloudUnreadReconciliation';
import { cloudGroupReadCursorsBySessionId } from './cloudSelfAgentCanonicalSync';
import { isNativeDesktopShell } from '@/lib/desktop';
import {
  CHAT_SYNC_LOCAL_STATE_CHANGED_EVENT,
  loadChatSyncUnreadCounts,
} from '@/lib/desktopChatSync';

type NativeUnreadSnapshot = {
  accountId: string;
  headsBySessionId: Record<string, {
    lastReadSequence: number;
    unreadCount: number;
  }>;
};

function unreadHeadsEqual(
  left: NativeUnreadSnapshot['headsBySessionId'],
  right: NativeUnreadSnapshot['headsBySessionId'],
) {
  const leftEntries = Object.entries(left);
  return leftEntries.length === Object.keys(right).length
    && leftEntries.every(([sessionId, head]) => (
      right[sessionId]?.lastReadSequence === head.lastReadSequence
      && right[sessionId]?.unreadCount === head.unreadCount
    ));
}

export function useCloudCanonicalReconciliation({
  account,
  canonical,
  messages,
  unread,
}: {
  account: CloudAccount | null;
  canonical: {
    state: CanonicalSessionState | null | undefined;
    setState?: Dispatch<
      SetStateAction<CanonicalSessionState | null>
    >;
  };
  messages: {
    fullByPeer: Record<string, CloudMessage[]> | null;
    index: CloudMessageIndex;
    authoritative: boolean;
  };
  unread: {
    contextKey: string | null;
    locallyReadSessionIds: ReadonlySet<string>;
    readInboundMessageIdsByPeer: Record<string, Set<string>>;
    setLocallyReadSessionIds: Dispatch<SetStateAction<Set<string>>>;
    setPublishedContextKey: Dispatch<
      SetStateAction<string | null>
    >;
  };
}) {
  const { state: canonicalState, setState: setCanonicalState } =
    canonical;
  const {
    fullByPeer: fullMessagesByPeer,
    index: messageIndex,
    authoritative,
  } = messages;
  const {
    contextKey: unreadContextKey,
    locallyReadSessionIds,
    readInboundMessageIdsByPeer,
    setLocallyReadSessionIds,
    setPublishedContextKey,
  } = unread;
  const nativeShell = isNativeDesktopShell();
  const [nativeUnreadSnapshot, setNativeUnreadSnapshot] =
    useState<NativeUnreadSnapshot | null>(null);
  const [nativeUnreadRevision, setNativeUnreadRevision] = useState(0);
  useEffect(() => {
    if (!nativeShell) return;
    const refreshUnread = () => setNativeUnreadRevision((current) => current + 1);
    window.addEventListener(CHAT_SYNC_LOCAL_STATE_CHANGED_EVENT, refreshUnread);
    return () => window.removeEventListener(CHAT_SYNC_LOCAL_STATE_CHANGED_EVENT, refreshUnread);
  }, [nativeShell]);
  const projectedUnreadBySessionId = useMemo(() => {
    if (!account || !fullMessagesByPeer) return null;
    return cloudUnreadCountsBySessionId({
      accountId: account.accountId,
      messagesByPeer: fullMessagesByPeer,
      readInboundMessageIdsByPeer,
      readCursorsBySessionId:
        cloudGroupReadCursorsBySessionId(canonicalState),
    });
  }, [
    account,
    canonicalState,
    fullMessagesByPeer,
    readInboundMessageIdsByPeer,
  ]);
  const optimisticReadSessionIds = useMemo(() => (
    cloudOptimisticallyReadSessionIds({
      messagesByPeer: messageIndex.sourceMessagesByPeer,
      readInboundMessageIdsByPeer,
    })
  ), [messageIndex, readInboundMessageIdsByPeer]);

  useEffect(() => {
    if (!nativeShell || !account || !authoritative) {
      return;
    }
    let cancelled = false;
    void loadChatSyncUnreadCounts(account.accountId)
      .then((rows) => {
        if (cancelled) return;
        const headsBySessionId = Object.fromEntries(rows.map((row) => [
          row.sessionId,
          {
            lastReadSequence: Math.max(0, row.lastReadSequence),
            unreadCount: Math.max(0, row.unreadCount),
          },
        ]));
        setNativeUnreadSnapshot((current) => (
          current?.accountId === account.accountId
          && unreadHeadsEqual(current.headsBySessionId, headsBySessionId)
            ? current
            : { accountId: account.accountId, headsBySessionId }
        ));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [
    account,
    authoritative,
    canonicalState?.participants,
    messageIndex.revision,
    nativeUnreadRevision,
    nativeShell,
  ]);

  const unreadBySessionId = useMemo(() => {
    if (!nativeShell) return projectedUnreadBySessionId;
    if (!account || nativeUnreadSnapshot?.accountId !== account.accountId) return null;
    return mergeNativeCloudUnreadCounts({
      nativeHeadsBySessionId: nativeUnreadSnapshot.headsBySessionId,
      locallyReadSessionIds,
      optimisticSessionIds: optimisticReadSessionIds,
      projectedUnreadBySessionId,
    });
  }, [
    account,
    locallyReadSessionIds,
    nativeShell,
    nativeUnreadSnapshot,
    optimisticReadSessionIds,
    projectedUnreadBySessionId,
  ]);

  useEffect(() => {
    if (!nativeShell || !nativeUnreadSnapshot) return;
    setLocallyReadSessionIds((current) => {
      const next = new Set(current);
      for (const sessionId of current) {
        if (nativeUnreadSnapshot.headsBySessionId[sessionId]?.unreadCount === 0) {
          next.delete(sessionId);
        }
      }
      return next.size === current.size ? current : next;
    });
  }, [nativeShell, nativeUnreadSnapshot, setLocallyReadSessionIds]);

  useEffect(() => {
    if (!account || !setCanonicalState) return;
    if (messageIndex.deliveryByMessageId.size === 0) return;
    setCanonicalState((current) =>
      patchCanonicalDeliverySummaries(
        current,
        messageIndex.deliveryByMessageId,
      )
    );
  }, [account, canonicalState?.messages.length, messageIndex, setCanonicalState]);

  useEffect(() => {
    if (
      !account
      || !canonicalState
      || !setCanonicalState
      || !authoritative
      || !unreadBySessionId
      || !unreadContextKey
    ) return;
    setCanonicalState((current) =>
      patchCanonicalCloudUnreadCounts(
        current,
        unreadBySessionId,
      )
    );
    setPublishedContextKey((current) =>
      current === unreadContextKey ? current : unreadContextKey
    );
  }, [
    account,
    authoritative,
    canonicalState,
    setCanonicalState,
    setPublishedContextKey,
    unreadBySessionId,
    unreadContextKey,
  ]);
  return unreadBySessionId;
}
