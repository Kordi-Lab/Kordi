import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import {
  cloudConversationKindFromConversationId,
  cloudDirectPersonSessionId,
  cloudPeerAccountIdFromConversationId,
  cloudSessionIdFromConversationId,
} from '@/features/collaboration/conversationIds';
import type { CloudAccount, CloudAuthClient, CloudMessage } from './authClient';
import { cloudDirectPersonMessagesForPeer } from './cloudCollaborationMemo';
import type { CloudMessageIndex } from './cloudMessageIndex';
import { addReadInboundMessageIds, rollbackReadInboundMessageIds } from './cloudReadTracking';
import { loadSession } from './session';

function directReadTarget(account: CloudAccount, activeId: string, index: CloudMessageIndex) {
  if (index.sourceAccountId !== account.accountId) return null;
  const peerId = cloudConversationKindFromConversationId(activeId) === 'person'
    ? cloudPeerAccountIdFromConversationId(activeId)
    : [...index.byPeerId.keys()].find(peer => (
        cloudDirectPersonSessionId(account.accountId, peer) === activeId
      ));
  if (!peerId || peerId === account.accountId) return null;
  const sessionId = cloudDirectPersonSessionId(account.accountId, peerId);
  const explicitSessionId = cloudSessionIdFromConversationId(activeId);
  if (explicitSessionId && explicitSessionId !== sessionId) return null;
  const messageIds = cloudDirectPersonMessagesForPeer(account, peerId, index.byPeerId.get(peerId) ?? [])
    .filter(message => (
      message.fromAccountId === peerId
      && message.toAccountId === account.accountId
      && message.direction === 'incoming'
      && !message.readAt
      && !index.groupRowByWireMessageId.has(message.messageId)
    ))
    .map(message => message.messageId);
  return messageIds.length ? { peerId, sessionId, messageIds } : null;
}

type ReadRequest = { messageIds: ReadonlySet<string> };

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
  const scopeRef = useRef<Map<string, ReadRequest> | null>(null);
  const accountId = account?.accountId;
  useEffect(() => {
    scopeRef.current = new Map();
    return () => { scopeRef.current = null; };
  }, [accountId]);

  useEffect(() => {
    if (!account || !activeConversationId || !canMarkActiveConversationRead) return;
    const scope = scopeRef.current;
    const target = directReadTarget(account, activeConversationId, messageIndex);
    if (!scope || !target) return;
    const { peerId, sessionId, messageIds } = target;
    const pending = scope.get(sessionId);
    if (pending && messageIds.every(id => pending.messageIds.has(id))) return;
    const request = { messageIds: new Set(messageIds) };
    scope.set(sessionId, request);

    // The transcript can show transport messages before canonical hydration.
    // Cover exactly those message IDs immediately, never the entire peer.
    setReadInboundMessageIdsByPeer(current => addReadInboundMessageIds(current, peerId, messageIds));
    void loadSession().then(async session => {
      if (scopeRef.current !== scope) return;
      if (!session?.token || session.accountId !== account.accountId) throw new Error('Cloud session is unavailable.');
      await client.markSessionMessagesRead(session.token, sessionId);
      if (scopeRef.current !== scope) return;
      setReadInboundMessageIdsByPeer(current => scopeRef.current === scope
        ? addReadInboundMessageIds(current, peerId, messageIds)
        : current);
      const coveredIds = request.messageIds;
      const readAt = new Date().toISOString();
      setMessagesByPeer(current => {
        if (scopeRef.current !== scope) return current;
        let changed = false;
        const messages = (current[peerId] ?? []).map(message => {
          if (!coveredIds.has(message.messageId) || message.readAt) return message;
          changed = true;
          return { ...message, readAt };
        });
        return changed ? { ...current, [peerId]: messages } : current;
      });
      void sync();
    }).catch(() => {
      if (scopeRef.current !== scope) return;
      const currentRequest = scope.get(sessionId);
      const failedIds = currentRequest && currentRequest !== request
        ? messageIds.filter(id => !currentRequest.messageIds.has(id))
        : messageIds;
      if (currentRequest === request) scope.delete(sessionId);
      if (failedIds.length === 0) return;
      setReadInboundMessageIdsByPeer(current => scopeRef.current === scope
        ? rollbackReadInboundMessageIds(current, peerId, failedIds)
        : current);
    });
  }, [account, activeConversationId, canMarkActiveConversationRead, client, messageIndex, setMessagesByPeer, setReadInboundMessageIdsByPeer, sync]);
}
