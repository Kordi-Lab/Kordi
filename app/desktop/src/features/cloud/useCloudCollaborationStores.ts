import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Dispatch,
  MutableRefObject,
  SetStateAction,
} from 'react';

import type {
  CanonicalSessionState,
  DesktopCollaborationState,
  DesktopChatTurnSnapshot,
} from '@/kordi-app/types';

import type {
  CloudAccount,
  CloudAuthClient,
  CloudMessage,
  CloudPublicProfile,
} from './authClient';
import type { CloudGroupReplayCoordinator } from './cloudGroupReplayCoordinator';
import type { CloudMessageCache } from './cloudMessageCache';
import {
  type CloudMessageIndex,
  type IndexedCloudGroupRow,
} from './cloudMessageIndex';
import type {
  CloudProfileIdentityAdoptionCoordinator,
  CloudSyncCoordinator,
} from './cloudSyncCoordinator';
import type { CloudUnreadReadinessSnapshot } from './cloudMessageSyncState';
import { useCloudAccountLifecycleState } from './useCloudAccountLifecycleState';
import { useCloudSessionVisibilityRefresh } from './useCloudSessionVisibilityRefresh';

const EMPTY_LOCAL_READ_SESSION_IDS = new Set<string>();

export type CloudCollaborationMessageStore = {
  value: Record<string, CloudMessage[]>;
  setValue: Dispatch<
    SetStateAction<Record<string, CloudMessage[]>>
  >;
  valueRef: MutableRefObject<Record<string, CloudMessage[]>>;
  onGroupRecoverySettled: () => void;
  onNativeGroupRecoverySettled: () => void;
  onGroupSessionRecoverySettled: (sessionId: string) => void;
  onSelfAgentRecoverySettled: () => void;
  pendingGroupProjectionSessionIds: ReadonlySet<string>;
  currentAccountValue: Record<string, CloudMessage[]>;
  fullCurrentAccountValue: Record<string, CloudMessage[]>;
  belongsToCurrentAccount: boolean;
  index: CloudMessageIndex;
  indexRef: MutableRefObject<CloudMessageIndex>;
  cacheAccountRef: MutableRefObject<string | null>;
  hydratedCacheAccountRef: MutableRefObject<string | null>;
  peerReadAtByPeerRef: MutableRefObject<Record<string, string>>;
};

export function useCloudCollaborationStores({
  account,
  canonicalState,
  client,
  messageCache,
  messageStore,
  syncCoordinator,
  profileIdentityAdoptionCoordinator,
  groupReplayCoordinator,
}: {
  account: CloudAccount | null;
  canonicalState?: CanonicalSessionState | null;
  client: CloudAuthClient;
  messageCache: CloudMessageCache;
  messageStore: CloudCollaborationMessageStore;
  syncCoordinator: CloudSyncCoordinator;
  profileIdentityAdoptionCoordinator:
    CloudProfileIdentityAdoptionCoordinator;
  groupReplayCoordinator:
    CloudGroupReplayCoordinator<IndexedCloudGroupRow>;
}) {
  const {
    value: messagesByPeer,
    setValue: setMessagesByPeer,
    valueRef: messagesByPeerRef,
    currentAccountValue: currentAccountMessagesByPeer,
    fullCurrentAccountValue: fullCurrentAccountMessagesByPeer,
    belongsToCurrentAccount: messagesBelongToCurrentAccount,
    index: messageIndex,
    indexRef: messageIndexRef,
    cacheAccountRef: messagesCacheAccountRef,
    hydratedCacheAccountRef: hydratedMessagesCacheAccountRef,
    peerReadAtByPeerRef,
  } = messageStore;
  const [unreadReadiness, setUnreadReadiness] =
    useState<CloudUnreadReadinessSnapshot>(() => ({
      status: account ? 'pending' : 'ready',
      contextKey: null,
    }));
  const [
    publishedUnreadContextKey,
    setPublishedUnreadContextKey,
  ] = useState<string | null>(null);
  const canonicalStateRef =
    useRef<CanonicalSessionState | null>(canonicalState ?? null);
  const profileCacheRef =
    useRef<Map<string, CloudPublicProfile>>(new Map());
  const [
    readInboundMessageIdsByPeer,
    setReadInboundMessageIdsByPeer,
  ] = useState<Record<string, Set<string>>>({});
  const localReadAccountId = account?.accountId ?? null;
  const [locallyReadState, setLocallyReadState] = useState<{
    accountId: string | null;
    sessionIds: Set<string>;
  }>({ accountId: localReadAccountId, sessionIds: new Set() });
  const locallyReadSessionIds = locallyReadState.accountId === localReadAccountId
    ? locallyReadState.sessionIds
    : EMPTY_LOCAL_READ_SESSION_IDS;
  const setLocallyReadSessionIds = useCallback<Dispatch<SetStateAction<Set<string>>>>((value) => {
    setLocallyReadState((current) => {
      const currentIds = current.accountId === localReadAccountId
        ? current.sessionIds
        : new Set<string>();
      const sessionIds = typeof value === 'function' ? value(currentIds) : value;
      return { accountId: localReadAccountId, sessionIds };
    });
  }, [localReadAccountId]);
  const [
    localAgentTurnsByRequestId,
    setLocalAgentTurnsByRequestId,
  ] = useState<Record<string, DesktopChatTurnSnapshot>>({});
  const [collaborationOverride, setCollaborationOverride] =
    useState<DesktopCollaborationState | null>(null);
  const [
    collaborationOverrideContextKey,
    setCollaborationOverrideContextKey,
  ] = useState<string | null>(null);
  const collaborationStateRef =
    useRef<DesktopCollaborationState | null>(null);
  const collaborationStateContextKeyRef =
    useRef<string | null>(null);
  const processedAgentMentionIdsRef = useRef<Set<string>>(new Set());
  const agentTurnIdsByRequestIdRef =
    useRef<Map<string, string>>(new Map());

  const lifecycle = useCloudAccountLifecycleState({
    account,
    messages: {
      cache: messageCache,
      value: messagesByPeer,
      setValue: setMessagesByPeer,
      valueRef: messagesByPeerRef,
      index: messageIndex,
      indexRef: messageIndexRef,
      cacheAccountRef: messagesCacheAccountRef,
      hydratedCacheAccountRef: hydratedMessagesCacheAccountRef,
      peerReadAtByPeerRef,
    },
    unread: {
      setReadiness: setUnreadReadiness,
      setPublishedContextKey: setPublishedUnreadContextKey,
    },
    collaboration: {
      stateRef: collaborationStateRef,
      stateContextKeyRef: collaborationStateContextKeyRef,
      setOverride: setCollaborationOverride,
      setOverrideContextKey: setCollaborationOverrideContextKey,
      setReadInboundMessageIdsByPeer,
      setLocalAgentTurnsByRequestId,
    },
    syncCoordinator,
    profileIdentityAdoptionCoordinator,
    groupReplayCoordinator,
  });
  const { resetAccountState } = lifecycle;

  useEffect(() => resetAccountState(), [resetAccountState]);

  useEffect(() => {
    canonicalStateRef.current = canonicalState ?? null;
  }, [canonicalState]);

  useCloudSessionVisibilityRefresh({
    account,
    client,
    setHiddenSessionIds:
      lifecycle.visibility.setHiddenSessionIds,
    setDeletedSessionIds:
      lifecycle.visibility.setDeletedSessionIds,
    setUnreadSessionIds:
      lifecycle.visibility.setUnreadSessionIds,
    setPinnedSessionIds:
      lifecycle.visibility.setPinnedSessionIds,
    setMutedSessionIds:
      lifecycle.visibility.setMutedSessionIds,
    setPinnedGroupSpaceIds:
      lifecycle.visibility.setPinnedGroupSpaceIds,
  });

  return {
    messages: {
      byPeer: messagesByPeer,
      setByPeer: setMessagesByPeer,
      byPeerRef: messagesByPeerRef,
      currentAccountByPeer: currentAccountMessagesByPeer,
      fullCurrentAccountByPeer: fullCurrentAccountMessagesByPeer,
      belongsToCurrentAccount: messagesBelongToCurrentAccount,
      index: messageIndex,
      indexRef: messageIndexRef,
      peerReadAtByPeerRef,
    },
    unread: {
      readiness: unreadReadiness,
      setReadiness: setUnreadReadiness,
      publishedContextKey: publishedUnreadContextKey,
      setPublishedContextKey: setPublishedUnreadContextKey,
      readInboundMessageIdsByPeer,
      setReadInboundMessageIdsByPeer,
      locallyReadSessionIds,
      setLocallyReadSessionIds,
    },
    canonicalStateRef,
    profileCacheRef,
    localTurns: {
      byRequestId: localAgentTurnsByRequestId,
      setByRequestId: setLocalAgentTurnsByRequestId,
    },
    collaboration: {
      override: collaborationOverride,
      setOverride: setCollaborationOverride,
      overrideContextKey: collaborationOverrideContextKey,
      setOverrideContextKey: setCollaborationOverrideContextKey,
      stateRef: collaborationStateRef,
      stateContextKeyRef: collaborationStateContextKeyRef,
    },
    agentRequests: {
      processedMentionIdsRef: processedAgentMentionIdsRef,
      turnIdsByRequestIdRef: agentTurnIdsByRequestIdRef,
    },
    ...lifecycle,
  };
}
