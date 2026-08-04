import { useEffect, useRef, useState } from 'react';
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
import {
  useCloudAccountLifecycleState,
  useCloudSessionVisibilityRefresh,
} from './useCloudAccountLifecycleState';

export type CloudCollaborationMessageStore = {
  value: Record<string, CloudMessage[]>;
  setValue: Dispatch<
    SetStateAction<Record<string, CloudMessage[]>>
  >;
  valueRef: MutableRefObject<Record<string, CloudMessage[]>>;
  currentAccountValue: Record<string, CloudMessage[]>;
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
  });

  return {
    messages: {
      byPeer: messagesByPeer,
      setByPeer: setMessagesByPeer,
      byPeerRef: messagesByPeerRef,
      currentAccountByPeer: currentAccountMessagesByPeer,
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
