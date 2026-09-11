import { cloudMessageDeletions } from './cloudMessageDeletions';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { cloudSessionIdFromConversationId } from '@/features/collaboration/conversationIds';
import { isNativeDesktopShell } from '@/lib/desktop';

import type { CloudAccount, CloudMessage } from './authClient';
import {
  type CloudMessageIndex,
} from './cloudMessageIndex';
import { createCloudMessageIndexer } from './cloudMessageIndexer';
import { canonicalRendererMessageIds, compactNativeCloudMessagesByPeer, NATIVE_RENDERER_MESSAGE_LIMIT_PER_PEER } from './cloudRendererRetention';
import type { CanonicalSessionMessage } from '@/kordi-app/types';
export { compactNativeCloudMessagesByPeer, NATIVE_RENDERER_MESSAGE_LIMIT_PER_PEER } from './cloudRendererRetention';
import type { CloudCollaborationMessageStore } from './useCloudCollaborationStores';
import type { CloudDirectHistoryPage } from './useCloudDirectHistory';
import { mergeCloudMessagesByPeerSnapshot } from './cloudMessageSyncState';

const EMPTY_CLOUD_MESSAGES_BY_PEER: Record<string, CloudMessage[]> = {};
const EMPTY_SESSION_IDS: ReadonlySet<string> = new Set();
type AccountMessageState = {
  accountId: string | null;
  messagesByPeer: Record<string, CloudMessage[]>;
};

export function useCloudCollaborationMessageStore(
  account: CloudAccount | null,
  activeConversationId?: string | null,
  canonicalMessages?: readonly CanonicalSessionMessage[],
  directHistory?: CloudDirectHistoryPage | null,
): CloudCollaborationMessageStore {
  const nativeShell = isNativeDesktopShell();
  const activeSessionId = activeConversationId
    ? cloudSessionIdFromConversationId(activeConversationId)
      ?? activeConversationId.trim()
    : null;
  const activeSessionIdRef = useRef(activeSessionId);
  const requiredMessageIds = useMemo(() => {
    const ids = canonicalRendererMessageIds(canonicalMessages);
    for (const rows of Object.values(directHistory?.messagesByPeer ?? {})) for (const row of rows) ids.add(row.messageId);
    return ids;
  }, [canonicalMessages, directHistory?.messagesByPeer]);
  const requiredMessageIdsRef = useRef(requiredMessageIds);
  const liveAccountIdRef = useRef(account?.accountId ?? null);
  const [messageState, setMessageState] = useState<AccountMessageState>({
    accountId: null,
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
    if (liveAccountIdRef.current !== accountId) return;
    const current = fullMessagesAccountIdRef.current === accountId
      ? fullMessagesByPeerRef.current
      : {};
    const next = cloudMessageDeletions.filter(accountId, typeof update === 'function' ? update(current) : update);
    fullMessagesAccountIdRef.current = accountId;
    const rendererValue = nativeShell && rendererCompactedRef.current
      ? compactNativeCloudMessagesByPeer(
          next,
          NATIVE_RENDERER_MESSAGE_LIMIT_PER_PEER,
          activeSessionIdRef.current,
          undefined, requiredMessageIdsRef.current,
        )
      : next;
    fullMessagesByPeerRef.current = rendererValue;
    setMessageState((published) => (
      published.accountId === accountId
      && published.messagesByPeer === rendererValue
        ? published
        : {
            accountId,
            messagesByPeer: rendererValue,
          }
    ));
  }, [account?.accountId, nativeShell]);
  const compactRendererValue = useCallback(() => {
    if (!nativeShell || rendererCompactedRef.current) return;
    if (liveAccountIdRef.current !== (account?.accountId ?? null)) return;
    rendererCompactedRef.current = true;
    const accountId = account?.accountId ?? null;
    const rendererValue = compactNativeCloudMessagesByPeer(
      fullMessagesAccountIdRef.current === accountId
        ? fullMessagesByPeerRef.current
        : {},
      NATIVE_RENDERER_MESSAGE_LIMIT_PER_PEER,
      activeSessionIdRef.current,
      undefined, requiredMessageIdsRef.current,
    );
    fullMessagesByPeerRef.current = rendererValue;
    setMessageState((current) => (
      current.accountId === accountId
      && current.messagesByPeer === rendererValue
        ? current
        : {
            accountId,
            messagesByPeer: rendererValue,
          }
    ));
  }, [account?.accountId, nativeShell]);
  const markRecoverySettled = useCallback((kind: 'group' | 'selfAgent') => {
    const accountId = account?.accountId ?? null;
    if (!accountId || liveAccountIdRef.current !== accountId) return;
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
  useLayoutEffect(() => {
    activeSessionIdRef.current = activeSessionId;
    liveAccountIdRef.current = account?.accountId ?? null;
    requiredMessageIdsRef.current = requiredMessageIds;
  }, [activeSessionId, account?.accountId, requiredMessageIds]);
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
    return directHistory ? mergeCloudMessagesByPeerSnapshot(
      directHistory.messagesByPeer, messagesByPeer, cloudMessageDeletions.ids(account?.accountId ?? null),
    ) : messagesByPeer;
  }, [account?.accountId, belongsToCurrentAccount, directHistory, messagesByPeer]);
  const indexRef = useRef<CloudMessageIndex>(null!);
  const indexMessages = useMemo(
    () => createCloudMessageIndexer(account?.accountId),
    [account?.accountId],
  );
  const index = useMemo(
    () => indexMessages(currentAccountMessagesByPeer),
    [indexMessages, currentAccountMessagesByPeer],
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
    fullCurrentAccountValue: currentAccountMessagesByPeer,
    belongsToCurrentAccount,
    index,
    indexRef,
    cacheAccountRef,
    hydratedCacheAccountRef,
    peerReadAtByPeerRef,
  };
}
