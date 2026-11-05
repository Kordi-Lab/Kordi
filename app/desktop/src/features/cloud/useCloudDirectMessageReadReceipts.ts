import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { CloudAccount, CloudAuthClient, CloudMessage } from './authClient';
import type { CloudMessageIndex } from './cloudMessageIndex';
import {
  addReadInboundMessageIds,
  cloudDirectReadTarget,
  rollbackReadInboundMessageIds,
} from './cloudReadTracking';
import { loadSession } from './session';

type ReadRequest = { messageIds: ReadonlySet<string> };
type ReadScope = { requests: Map<string, ReadRequest>; acknowledgedIds: Set<string> };

export function useCloudDirectMessageReadReceipts({
  account, activeConversationId, canMarkActiveConversationRead, client,
  messageIndex, setMessagesByPeer, setReadInboundMessageIdsByPeer, sync,
}: {
  account: CloudAccount | null;
  activeConversationId: string | null | undefined;
  canMarkActiveConversationRead: boolean;
  client: CloudAuthClient;
  messageIndex: CloudMessageIndex;
  setMessagesByPeer: Dispatch<SetStateAction<Record<string, CloudMessage[]>>>;
  setReadInboundMessageIdsByPeer: Dispatch<SetStateAction<Record<string, Set<string>>>>;
  sync: () => Promise<void>;
}) {
  const scopeRef = useRef<ReadScope | null>(null);
  const accountId = account?.accountId;
  useEffect(() => {
    scopeRef.current = { requests: new Map(), acknowledgedIds: new Set() };
    return () => { scopeRef.current = null; };
  }, [accountId]);

  useEffect(() => {
    if (!account || !activeConversationId || !canMarkActiveConversationRead) return;
    const scope = scopeRef.current;
    const target = cloudDirectReadTarget(account, activeConversationId, messageIndex);
    if (!scope || !target) return;
    const { peerId, sessionId, messageIds, observedSequence } = target;
    const pending = scope.requests.get(sessionId);
    if (pending && messageIds.every(id => pending.messageIds.has(id))) return;
    const request = { messageIds: new Set(messageIds) };
    scope.requests.set(sessionId, request);

    // The transcript can show transport messages before canonical hydration.
    // Cover exactly those message IDs immediately, never the entire peer.
    setReadInboundMessageIdsByPeer(current => addReadInboundMessageIds(current, peerId, messageIds));
    void loadSession().then(async session => {
      if (scopeRef.current !== scope) return;
      if (!session?.token || session.accountId !== account.accountId) throw new Error('Cloud session is unavailable.');
      // Native sync can display a newer message than this client's cached head.
      // Acknowledge the observed sequence so the durable cursor catches up too.
      await client.markSessionMessagesRead(session.token, sessionId, observedSequence);
      if (scopeRef.current !== scope) return;
      for (const messageId of messageIds) scope.acknowledgedIds.add(messageId);
      setReadInboundMessageIdsByPeer(current => scopeRef.current === scope
        ? addReadInboundMessageIds(current, peerId, messageIds)
        : current);
      const coveredIds = request.messageIds;
      const readAt = new Date().toISOString();
      setMessagesByPeer(current => {
        if (scopeRef.current !== scope) return current;
        let changed = false;
        const messages = (current[peerId] ?? []).map(message => {
          if (!coveredIds.has(message.messageId) || message.fromAccountId !== peerId || message.readAt) return message;
          changed = true;
          return { ...message, readAt };
        });
        return changed ? { ...current, [peerId]: messages } : current;
      });
      void sync();
    }).catch(() => {
      if (scopeRef.current !== scope) return;
      const currentRequest = scope.requests.get(sessionId);
      // Failure cannot undo an acknowledgment from any overlapping request,
      // including an older request that completed after this one was started.
      const failedIds = messageIds.filter(id => !scope.acknowledgedIds.has(id)
        && (currentRequest === request || !currentRequest?.messageIds.has(id)));
      if (currentRequest === request) scope.requests.delete(sessionId);
      if (failedIds.length === 0) return;
      setReadInboundMessageIdsByPeer(current => scopeRef.current === scope
        ? rollbackReadInboundMessageIds(current, peerId, failedIds)
        : current);
    });
  }, [account, activeConversationId, canMarkActiveConversationRead, client, messageIndex, setMessagesByPeer, setReadInboundMessageIdsByPeer, sync]);
}
