import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { cloudSessionIdFromConversationId } from '@/features/collaboration/conversationIds';
import { isNativeDesktopShell } from '@/lib/desktop';

import type { CloudAccount, CloudMessage } from './authClient';
import {
  buildCloudMessageIndex,
  type CloudMessageIndex,
} from './cloudMessageIndex';
import { compareCloudMessages } from './cloudMessageMerge';
import type { CloudCollaborationMessageStore } from './useCloudCollaborationStores';

const EMPTY_CLOUD_MESSAGES_BY_PEER: Record<string, CloudMessage[]> = {};
const EMPTY_SESSION_IDS: ReadonlySet<string> = new Set();
export const NATIVE_RENDERER_MESSAGE_LIMIT_PER_PEER = 64;

export function compactNativeCloudMessagesByPeer(
  messagesByPeer: Record<string, CloudMessage[]>,
  limit = NATIVE_RENDERER_MESSAGE_LIMIT_PER_PEER,
  activeSessionId?: string | null,
) {
  let changed = false;
  const compacted: Record<string, CloudMessage[]> = {};
  for (const [peerId, messages] of Object.entries(messagesByPeer)) {
    if (messages.length <= limit) {
      compacted[peerId] = messages;
      continue;
    }
    const ordered = [...messages].sort(compareCloudMessages);
    const keptIds = new Set(
      ordered.slice(-limit).map((message) => message.messageId),
    );
    const latestBySession = new Map<string, CloudMessage>();
    const latestRouteBySession = new Map<string, CloudMessage>();
    for (const message of ordered) {
      const sessionKey = message.sessionId?.trim()
        || message.conversationId?.trim()
        || peerId;
      if (activeSessionId && sessionKey === activeSessionId) {
        keptIds.add(message.messageId);
      }
      latestBySession.set(sessionKey, message);
      if (message.messageKind === 'agent-model-change') {
        latestRouteBySession.set(sessionKey, message);
      }
      if (message.direction === 'outgoing' && !message.deliveredAt) {
        keptIds.add(message.messageId);
      }
    }
    for (const message of latestBySession.values()) keptIds.add(message.messageId);
    for (const message of latestRouteBySession.values()) keptIds.add(message.messageId);
    // ponytail: keep a 64-row peer tail plus session heads and pending rows;
    // replace this compatibility window when every legacy hook reads SQLite.
    const peerMessages = ordered.filter((message) => keptIds.has(message.messageId));
    compacted[peerId] = peerMessages;
    changed ||= peerMessages.length !== messages.length
      || peerMessages.some((message, index) => message !== messages[index]);
  }
  return changed ? compacted : messagesByPeer;
}

type AccountMessageState = {
  accountId: string | null;
  compacted: boolean;
  fullMessagesByPeer: Record<string, CloudMessage[]>;
  messagesByPeer: Record<string, CloudMessage[]>;
};

export function useCloudCollaborationMessageStore(
  account: CloudAccount | null,
  activeConversationId?: string | null,
): CloudCollaborationMessageStore {
  const nativeShell = isNativeDesktopShell();
  const activeSessionId = activeConversationId
    ? cloudSessionIdFromConversationId(activeConversationId)
      ?? activeConversationId.trim()
    : null;
  const activeSessionIdRef = useRef(activeSessionId);
  const [messageState, setMessageState] = useState<AccountMessageState>({
    accountId: null,
    compacted: false,
    fullMessagesByPeer: {},
    messagesByPeer: {},
  });
  const fullMessagesByPeerRef = useRef<Record<string, CloudMessage[]>>({});
  const fullMessagesAccountIdRef = useRef<string | null>(null);
  const rendererCompactedRef = useRef(false);
  const recoveryBarrierRef = useRef({
    accountId: null as string | null,
    group: false,
    selfAgent: false,
  });
  const [settledGroupProjection, setSettledGroupProjection] = useState<{
    accountId: string | null;
    complete: boolean;
    sessionIds: ReadonlySet<string>;
  }>({ accountId: null, complete: false, sessionIds: EMPTY_SESSION_IDS });
  const messagesByPeer = messageState.messagesByPeer;
  const setMessagesByPeer = useCallback<
    CloudCollaborationMessageStore['setValue']
  >((update) => {
    const accountId = account?.accountId ?? null;
    const current = fullMessagesAccountIdRef.current === accountId
      ? fullMessagesByPeerRef.current
      : {};
    const next = typeof update === 'function' ? update(current) : update;
    fullMessagesAccountIdRef.current = accountId;
    fullMessagesByPeerRef.current = next;
    const rendererValue = nativeShell && rendererCompactedRef.current
      ? compactNativeCloudMessagesByPeer(
          next,
          NATIVE_RENDERER_MESSAGE_LIMIT_PER_PEER,
          activeSessionIdRef.current,
        )
      : next;
    setMessageState((published) => (
      published.accountId === accountId
      && published.fullMessagesByPeer === next
      && published.messagesByPeer === rendererValue
        ? published
        : {
            accountId,
            compacted: nativeShell && rendererCompactedRef.current,
            fullMessagesByPeer: next,
            messagesByPeer: rendererValue,
          }
    ));
  }, [account?.accountId, nativeShell]);
  const compactRendererValue = useCallback(() => {
    if (!nativeShell || rendererCompactedRef.current) return;
    rendererCompactedRef.current = true;
    const accountId = account?.accountId ?? null;
    const rendererValue = compactNativeCloudMessagesByPeer(
      fullMessagesAccountIdRef.current === accountId
        ? fullMessagesByPeerRef.current
        : {},
      NATIVE_RENDERER_MESSAGE_LIMIT_PER_PEER,
      activeSessionIdRef.current,
    );
    setMessageState((current) => (
      current.accountId === accountId
      && current.messagesByPeer === rendererValue
        ? current
        : {
            accountId,
            compacted: true,
            fullMessagesByPeer: fullMessagesByPeerRef.current,
            messagesByPeer: rendererValue,
          }
    ));
  }, [account?.accountId, nativeShell]);
  const markRecoverySettled = useCallback((kind: 'group' | 'selfAgent') => {
    const accountId = account?.accountId ?? null;
    if (!accountId) return;
    const current = recoveryBarrierRef.current.accountId === accountId
      ? recoveryBarrierRef.current
      : { accountId, group: false, selfAgent: false };
    const next = { ...current, [kind]: true };
    recoveryBarrierRef.current = next;
    if (next.group && next.selfAgent) compactRendererValue();
  }, [account?.accountId, compactRendererValue]);
  const onGroupSessionRecoverySettled = useCallback((sessionId: string) => {
    const accountId = account?.accountId ?? null;
    const normalizedSessionId = sessionId.trim();
    if (!accountId || !normalizedSessionId) return;
    setSettledGroupProjection((current) => {
      const sessionIds = current.accountId === accountId
        ? current.sessionIds
        : EMPTY_SESSION_IDS;
      if (sessionIds.has(normalizedSessionId)) return current;
      return {
        accountId,
        complete: current.accountId === accountId && current.complete,
        sessionIds: new Set([...sessionIds, normalizedSessionId]),
      };
    });
  }, [account?.accountId]);
  const onNativeGroupRecoverySettled = useCallback(() => {
    const accountId = account?.accountId ?? null;
    if (!accountId) return;
    setSettledGroupProjection((current) => {
      if (current.accountId === accountId && current.complete) return current;
      return {
        accountId,
        complete: true,
        sessionIds: current.accountId === accountId
          ? current.sessionIds
          : EMPTY_SESSION_IDS,
      };
    });
  }, [account?.accountId]);
  const onGroupRecoverySettled = useCallback(
    () => markRecoverySettled('group'),
    [markRecoverySettled],
  );
  const onSelfAgentRecoverySettled = useCallback(
    () => markRecoverySettled('selfAgent'),
    [markRecoverySettled],
  );
  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);
  useEffect(() => {
    rendererCompactedRef.current = false;
    recoveryBarrierRef.current = {
      accountId: account?.accountId ?? null,
      group: false,
      selfAgent: false,
    };
    fullMessagesAccountIdRef.current = null;
    fullMessagesByPeerRef.current = {};
  }, [account?.accountId]);
  const cacheAccountRef = useRef<string | null>(null);
  const hydratedCacheAccountRef = useRef<string | null>(null);
  const peerReadAtByPeerRef = useRef<Record<string, string>>({});
  const belongsToCurrentAccount = Boolean(
    account?.accountId && messageState.accountId === account.accountId,
  );
  const currentAccountMessagesByPeer = useMemo(() => {
    if (!belongsToCurrentAccount) return EMPTY_CLOUD_MESSAGES_BY_PEER;
    if (!nativeShell || !messageState.compacted) return messagesByPeer;
    return compactNativeCloudMessagesByPeer(
      messageState.fullMessagesByPeer,
      NATIVE_RENDERER_MESSAGE_LIMIT_PER_PEER,
      activeSessionId,
    );
  }, [activeSessionId, belongsToCurrentAccount, messageState, messagesByPeer, nativeShell]);
  const fullCurrentAccountMessagesByPeer = belongsToCurrentAccount
    ? messageState.fullMessagesByPeer
    : EMPTY_CLOUD_MESSAGES_BY_PEER;
  const indexRef = useRef<CloudMessageIndex>(null!);
  const index = useMemo(
    () => buildCloudMessageIndex(
      account?.accountId ?? null,
      currentAccountMessagesByPeer,
    ),
    [account?.accountId, currentAccountMessagesByPeer],
  );
  useEffect(() => {
    indexRef.current = index;
  }, [index]);
  const settledGroupSessionIds = settledGroupProjection.accountId === account?.accountId
    ? settledGroupProjection.sessionIds
    : EMPTY_SESSION_IDS;
  const groupProjectionRecoveryComplete =
    settledGroupProjection.accountId === account?.accountId
    && settledGroupProjection.complete;
  const pendingGroupProjectionSessionIds = useMemo(() => {
    if (!nativeShell || groupProjectionRecoveryComplete) return EMPTY_SESSION_IDS;
    const pending = new Set<string>();
    for (const sessionId of index.groupRowsBySessionId.keys()) {
      if (!settledGroupSessionIds.has(sessionId)) pending.add(sessionId);
    }
    return pending.size > 0 ? pending : EMPTY_SESSION_IDS;
  }, [groupProjectionRecoveryComplete, index, nativeShell, settledGroupSessionIds]);
  return {
    value: messagesByPeer,
    setValue: setMessagesByPeer,
    valueRef: fullMessagesByPeerRef,
    onGroupRecoverySettled,
    onNativeGroupRecoverySettled,
    onGroupSessionRecoverySettled,
    onSelfAgentRecoverySettled,
    pendingGroupProjectionSessionIds,
    currentAccountValue: currentAccountMessagesByPeer,
    fullCurrentAccountValue: fullCurrentAccountMessagesByPeer,
    belongsToCurrentAccount,
    index,
    indexRef,
    cacheAccountRef,
    hydratedCacheAccountRef,
    peerReadAtByPeerRef,
  };
}
