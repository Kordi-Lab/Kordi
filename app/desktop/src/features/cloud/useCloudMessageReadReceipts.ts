import {
  useEffect,
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

export function rollbackReadInboundMessageIds(
  current: Record<string, Set<string>>,
  peerId: string,
  messageIds: readonly string[],
): Record<string, Set<string>> {
  const existing = current[peerId];
  if (!existing) return current;
  const next = new Set(existing);
  for (const messageId of messageIds) next.delete(messageId);
  if (next.size === existing.size) return current;
  const result = { ...current };
  if (next.size > 0) result[peerId] = next;
  else delete result[peerId];
  return result;
}

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
  const { setState: setCanonicalState } = canonical;
  const {
    setByPeer: setMessagesByPeer,
    index: messageIndex,
    sync,
  } = messages;

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
      const groupSessionIds = new Set(groupReadTargets.sessionIds);
      const optimisticGroupMessageIdsByPeer = new Map<string, string[]>();
      for (const row of messageIndex.groupRows) {
        if (!groupSessionIds.has(row.envelope.groupId)) continue;
        const peerId = row.wire.fromAccountId.trim();
        if (!peerId || row.wire.toAccountId !== account.accountId) continue;
        const messageIds = optimisticGroupMessageIdsByPeer.get(peerId) ?? [];
        messageIds.push(row.wire.messageId);
        optimisticGroupMessageIdsByPeer.set(peerId, messageIds);
      }
      setReadInboundMessageIdsByPeer((current) => {
        let changed = false;
        const next = { ...current };
        for (const [peerId, messageIds] of optimisticGroupMessageIdsByPeer) {
          const existing = current[peerId] ?? new Set<string>();
          const merged = new Set(existing);
          for (const messageId of messageIds) merged.add(messageId);
          if (merged.size === existing.size) continue;
          next[peerId] = merged;
          changed = true;
        }
        return changed ? next : current;
      });
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
          if (!session?.token) throw new Error('Cloud session is unavailable.');
          const readRequests = groupReadTargets.sessionIds.map((sessionId) =>
            client.markSessionMessagesRead(
              session.token,
              sessionId,
            )
          );
          return Promise.all(readRequests);
        })
        .then(() => {
          void sync();
        })
        .catch(() => {
          setReadInboundMessageIdsByPeer((current) => {
            let next = current;
            for (const [peerId, messageIds] of optimisticGroupMessageIdsByPeer) {
              next = rollbackReadInboundMessageIds(next, peerId, messageIds);
            }
            return next;
          });
        });
    }
  }, [
    account,
    activeConversationId,
    canMarkActiveConversationRead,
    client,
    messageIndex,
    setCanonicalState,
    setMessagesByPeer,
    setReadInboundMessageIdsByPeer,
    sync,
  ]);
}
