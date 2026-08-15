import {
  useEffect,
  useRef,
  type Dispatch,
  type SetStateAction,
} from 'react';
import {
  markCanonicalSessionRead,
} from '@/lib/desktop';
import {
  mergeCanonicalReadCursorDelta,
} from '@/features/canonical/canonicalStateReducers';
import type {
  CanonicalSessionState,
} from '@/kordi-app/types';
import type {
  CloudAccount,
  CloudAuthClient,
  CloudMessage,
} from './authClient';
import {
  cloudPeerAccountIdFromConversationId,
  cloudSessionIdFromConversationId,
} from './cloudCollaborationState';
import {
  cloudGroupMessageReadTargets,
} from './cloudGroupMessages';
import type {
  CloudMessageIndex,
} from './cloudMessageIndex';
import {
  markCloudMessagesReadLocally,
} from './cloudMessageSyncState';
import {
  isSharedCloudSessionId,
} from './cloudSelfAgentCanonicalSync';
import type {
  CloudMessageSyncController,
} from './useCloudMessageSync';
import {
  loadSession,
} from './session';

type SyncCloudCollaborationDiff =
  CloudMessageSyncController['syncCloudCollaborationDiff'];

export function useCloudMessageReadReceipts({
  account,
  activeConversationId,
  canMarkActiveConversationRead,
  client,
  canonical,
  messages,
  setReadInboundMessageIdsByPeer,
}: {
  account: CloudAccount | null;
  activeConversationId: string | null | undefined;
  canMarkActiveConversationRead: boolean;
  client: CloudAuthClient;
  canonical: {
    setState?: Dispatch<
      SetStateAction<CanonicalSessionState | null>
    >;
  };
  messages: {
    byPeer: Record<string, CloudMessage[]>;
    setByPeer: Dispatch<
      SetStateAction<Record<string, CloudMessage[]>>
    >;
    index: CloudMessageIndex;
    sync: SyncCloudCollaborationDiff;
  };
  setReadInboundMessageIdsByPeer: Dispatch<
    SetStateAction<Record<string, Set<string>>>
  >;
}) {
  const readReceiptRequestRef = useRef<string | null>(null);
  const { setState: setCanonicalState } = canonical;
  const {
    byPeer: messagesByPeer,
    setByPeer: setMessagesByPeer,
    index: messageIndex,
    sync,
  } = messages;

  useEffect(() => {
    readReceiptRequestRef.current = null;
  }, [account?.accountId]);

  useEffect(() => {
    if (!account || !activeConversationId || !canMarkActiveConversationRead) {
      return;
    }
    const activeConversationIds = [
      activeConversationId,
      cloudSessionIdFromConversationId(activeConversationId),
    ];
    const groupReadTargets = cloudGroupMessageReadTargets({
      accountId: account.accountId,
      activeConversationId,
      activeConversationIds,
      groupRows: messageIndex.groupRows,
    });
    if (
      groupReadTargets.peerIds.length > 0
      || groupReadTargets.sessionIds.length > 0
    ) {
      setMessagesByPeer((current) => {
        const next = markCloudMessagesReadLocally(
          current,
          account.accountId,
          {
            ...groupReadTargets,
            groupRowByWireMessageId:
              messageIndex.groupRowByWireMessageId,
          },
        );
        return next;
      });

      const canonicalReadSessionIds = [
        ...new Set(
          activeConversationIds.filter(
            (sessionId): sessionId is string =>
              typeof sessionId === 'string'
              && isSharedCloudSessionId(sessionId),
          ),
        ),
      ];
      if (canonicalReadSessionIds.length > 0) {
        void Promise.all(
          canonicalReadSessionIds.map((sessionId) =>
            markCanonicalSessionRead({ sessionId })
          ),
        )
          .then((deltas) => {
            setCanonicalState?.((current) =>
              deltas.reduce(
                (next, delta) =>
                  mergeCanonicalReadCursorDelta(next, delta),
                current,
              )
            );
          })
          .catch(() => {});
      }

      void loadSession()
        .then((session) => {
          if (!session?.token) return null;
          const readRequests =
            groupReadTargets.sessionIds.length > 0
              ? groupReadTargets.sessionIds.map((sessionId) =>
                  client.markSessionMessagesRead(
                    session.token,
                    sessionId,
                  )
                )
              : groupReadTargets.peerIds.map((peerId) =>
                  client.markMessagesRead(session.token, peerId)
                );
          return Promise.all(readRequests);
        })
        .then((result) => {
          if (result === null) return;
          void sync();
        })
        .catch(() => {});
    }

    const peerId =
      cloudPeerAccountIdFromConversationId(activeConversationId);
    if (!peerId) return;
    const inboundIds = (messagesByPeer[peerId] ?? [])
      .filter(
        (message) => message.toAccountId === account.accountId,
      )
      .map((message) => message.messageId)
      .filter(Boolean);
    if (inboundIds.length === 0) return;
    setReadInboundMessageIdsByPeer((current) => {
      const existing = current[peerId] ?? new Set<string>();
      const next = new Set(existing);
      for (const id of inboundIds) next.add(id);
      if (next.size === existing.size) return current;
      return { ...current, [peerId]: next };
    });
    const readSignature =
      `${peerId}:${inboundIds.slice().sort().join(',')}`;
    if (readReceiptRequestRef.current === readSignature) return;
    readReceiptRequestRef.current = readSignature;
    void loadSession()
      .then((session) => {
        if (!session?.token) return null;
        return client.markMessagesRead(session.token, peerId);
      })
      .then((result) => {
        if (result === null) return;
        setMessagesByPeer((current) => {
          const next = markCloudMessagesReadLocally(
            current,
            account.accountId,
            { peerIds: [peerId] },
          );
          return next;
        });
        void sync();
      })
      .catch(() => {
        readReceiptRequestRef.current = null;
      });
  }, [
    account,
    activeConversationId,
    canMarkActiveConversationRead,
    client,
    messageIndex,
    messagesByPeer,
    setCanonicalState,
    setMessagesByPeer,
    setReadInboundMessageIdsByPeer,
    sync,
  ]);
}
