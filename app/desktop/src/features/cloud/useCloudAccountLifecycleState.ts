import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import type {
  DesktopCollaborationState,
  DesktopChatTurnSnapshot,
} from '@/kordi-app/types';
import type {
  CloudAccount,
  CloudAuthClient,
  CloudMessage,
  CloudSessionForkSummary,
} from './authClient';
import type {
  CloudAgentDefinition,
  SharedCloudAgentSummary,
} from './cloudAgents';
import {
  loadCloudSessionVisibility,
  saveCloudSessionVisibility,
  type CloudSessionPinsById,
  type CloudSessionTitlesById,
} from './cloudDiffSync';
import {
  EMPTY_CLOUD_SESSION_ACTIVITY,
  loadCachedCloudSessionActivity,
  saveCachedCloudSessionActivity,
  type CloudSessionActivityStore,
} from './cloudSessionActivity';
import type {
  CloudMessageIndex,
  IndexedCloudGroupRow,
} from './cloudMessageIndex';
import type {
  CloudMessageCache,
} from './cloudMessageCache';
import type {
  CloudGroupReplayCoordinator,
} from './cloudGroupReplayCoordinator';
import type {
  CloudProfileIdentityAdoptionCoordinator,
  CloudSyncCoordinator,
} from './cloudSyncCoordinator';
import {
  cloudMessagesByPeerEqual,
  cloudUnreadReadinessContextKey,
  mergeCloudMessagesByPeerSnapshot,
  reconcileCloudPeerReadCursors,
  type CloudUnreadReadinessSnapshot,
} from './cloudMessageSyncState';
import {
  resetCloudAttachmentPreviewLoader,
} from './cloudAttachments';
import {
  loadSession,
} from './session';

type CloudAccountMessageStore = {
  cache: CloudMessageCache;
  value: Record<string, CloudMessage[]>;
  setValue: Dispatch<
    SetStateAction<Record<string, CloudMessage[]>>
  >;
  valueRef: MutableRefObject<Record<string, CloudMessage[]>>;
  index: CloudMessageIndex;
  indexRef: MutableRefObject<CloudMessageIndex>;
  cacheAccountRef: MutableRefObject<string | null>;
  hydratedCacheAccountRef: MutableRefObject<string | null>;
  peerReadAtByPeerRef: MutableRefObject<Record<string, string>>;
};

type CloudAccountUnreadStore = {
  setReadiness: Dispatch<
    SetStateAction<CloudUnreadReadinessSnapshot>
  >;
  setPublishedContextKey: Dispatch<SetStateAction<string | null>>;
};

type CloudAccountCollaborationStore = {
  stateRef: MutableRefObject<DesktopCollaborationState | null>;
  stateContextKeyRef: MutableRefObject<string | null>;
  setOverride: Dispatch<
    SetStateAction<DesktopCollaborationState | null>
  >;
  setOverrideContextKey: Dispatch<SetStateAction<string | null>>;
  setReadInboundMessageIdsByPeer: Dispatch<
    SetStateAction<Record<string, Set<string>>>
  >;
  setLocalAgentTurnsByRequestId: Dispatch<
    SetStateAction<Record<string, DesktopChatTurnSnapshot>>
  >;
};

export function useCloudAccountLifecycleState({
  account,
  messages,
  unread,
  collaboration,
  syncCoordinator,
  profileIdentityAdoptionCoordinator,
  groupReplayCoordinator,
}: {
  account: CloudAccount | null;
  messages: CloudAccountMessageStore;
  unread: CloudAccountUnreadStore;
  collaboration: CloudAccountCollaborationStore;
  syncCoordinator: CloudSyncCoordinator;
  profileIdentityAdoptionCoordinator:
    CloudProfileIdentityAdoptionCoordinator;
  groupReplayCoordinator:
    CloudGroupReplayCoordinator<IndexedCloudGroupRow>;
}) {
  const {
    cache: messageCache,
    value: messagesByPeer,
    setValue: setMessagesByPeer,
    valueRef: messagesByPeerRef,
    index: messageIndex,
    indexRef: messageIndexRef,
    cacheAccountRef: messagesCacheAccountRef,
    hydratedCacheAccountRef,
    peerReadAtByPeerRef,
  } = messages;
  const {
    setReadiness: setUnreadReadiness,
    setPublishedContextKey,
  } = unread;
  const {
    stateRef: collaborationStateRef,
    stateContextKeyRef: collaborationStateContextKeyRef,
    setOverride: setCollaborationOverride,
    setOverrideContextKey: setCollaborationOverrideContextKey,
    setReadInboundMessageIdsByPeer,
    setLocalAgentTurnsByRequestId,
  } = collaboration;
  const [sessionActivity, setSessionActivity] =
    useState<CloudSessionActivityStore>(
      () => loadCachedCloudSessionActivity(account?.accountId),
    );
  const [sessionForksById, setSessionForksById] =
    useState<Record<string, CloudSessionForkSummary>>({});
  const [sessionPinsById, setSessionPinsById] =
    useState<CloudSessionPinsById>({});
  const [sessionTitlesById, setSessionTitlesById] =
    useState<CloudSessionTitlesById>({});
  const [agentDefinitionsById, setAgentDefinitionsById] =
    useState<Record<string, CloudAgentDefinition>>({});
  const [sharedAgentsByOwner, setSharedAgentsByOwner] =
    useState<Record<string, SharedCloudAgentSummary[]>>({});
  const [hiddenSessionIds, setHiddenSessionIds] = useState<Set<string>>(
    () => loadCloudSessionVisibility(account?.accountId).hiddenSessionIds,
  );
  const [deletedSessionIds, setDeletedSessionIds] = useState<Set<string>>(
    () => loadCloudSessionVisibility(account?.accountId).deletedSessionIds,
  );

  const sessionActivityRef =
    useRef<CloudSessionActivityStore>(sessionActivity);
  const sessionForksByIdRef =
    useRef<Record<string, CloudSessionForkSummary>>(sessionForksById);
  const sessionPinsByIdRef =
    useRef<CloudSessionPinsById>(sessionPinsById);
  const sessionTitlesByIdRef =
    useRef<CloudSessionTitlesById>(sessionTitlesById);
  const groupSessionTitleBackfillsRef = useRef<Set<string>>(new Set());
  const agentDefinitionsByIdRef =
    useRef<Record<string, CloudAgentDefinition>>(agentDefinitionsById);
  const hiddenSessionIdsRef = useRef<Set<string>>(hiddenSessionIds);
  const deletedSessionIdsRef = useRef<Set<string>>(deletedSessionIds);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  useEffect(() => () => {
    groupReplayCoordinator.dispose();
  }, [groupReplayCoordinator]);

  useEffect(() => {
    messagesByPeerRef.current = messagesByPeer;
    if (
      account
      && messagesCacheAccountRef.current === account.accountId
      && hydratedCacheAccountRef.current === account.accountId
    ) {
      void messageCache.save(account.accountId, messagesByPeer)
        .catch(() => {});
    }
  }, [
    account,
    hydratedCacheAccountRef,
    messageCache,
    messagesByPeer,
    messagesByPeerRef,
    messagesCacheAccountRef,
  ]);

  useEffect(() => {
    messageIndexRef.current = messageIndex;
  }, [messageIndex, messageIndexRef]);

  useEffect(() => {
    sessionActivityRef.current = sessionActivity;
    if (
      account
      && messagesCacheAccountRef.current === account.accountId
    ) {
      saveCachedCloudSessionActivity(
        account.accountId,
        sessionActivity,
      );
    }
  }, [account, messagesCacheAccountRef, sessionActivity]);

  useEffect(() => {
    sessionForksByIdRef.current = sessionForksById;
  }, [sessionForksById]);

  useEffect(() => {
    sessionPinsByIdRef.current = sessionPinsById;
  }, [sessionPinsById]);

  useEffect(() => {
    sessionTitlesByIdRef.current = sessionTitlesById;
  }, [sessionTitlesById]);

  useEffect(() => {
    agentDefinitionsByIdRef.current = agentDefinitionsById;
  }, [agentDefinitionsById]);

  useEffect(() => {
    hiddenSessionIdsRef.current = hiddenSessionIds;
  }, [hiddenSessionIds]);

  useEffect(() => {
    deletedSessionIdsRef.current = deletedSessionIds;
  }, [deletedSessionIds]);

  useEffect(() => {
    if (
      !account
      || messagesCacheAccountRef.current !== account.accountId
    ) return;
    saveCloudSessionVisibility(account.accountId, {
      hiddenSessionIds,
      deletedSessionIds,
    });
  }, [
    account,
    deletedSessionIds,
    hiddenSessionIds,
    messagesCacheAccountRef,
  ]);

  useEffect(() => () => {
    profileIdentityAdoptionCoordinator.changeAccount();
  }, [account?.accountId, profileIdentityAdoptionCoordinator]);

  const resetAccountState = useCallback(() => {
    syncCoordinator.changeAccount();
    const generation = syncCoordinator.currentGeneration();
    resetCloudAttachmentPreviewLoader();
    const accountId = account?.accountId ?? null;
    groupReplayCoordinator.changeAccount(accountId);
    messagesCacheAccountRef.current = accountId;
    hydratedCacheAccountRef.current = null;
    peerReadAtByPeerRef.current = {};
    messagesByPeerRef.current = {};
    setMessagesByPeer({});
    setUnreadReadiness({
      status: accountId ? 'pending' : 'ready',
      contextKey: accountId
        ? cloudUnreadReadinessContextKey(accountId, generation, '')
        : null,
    });
    setPublishedContextKey(null);
    collaborationStateRef.current = null;
    collaborationStateContextKeyRef.current = null;
    setCollaborationOverride(null);
    setCollaborationOverrideContextKey(null);
    setReadInboundMessageIdsByPeer({});
    setLocalAgentTurnsByRequestId({});

    let cancelled = false;
    if (accountId) {
      void messageCache.load(accountId)
        .then((cached) => {
          if (
            cancelled
            || messagesCacheAccountRef.current !== accountId
          ) return;
          setMessagesByPeer((current) => {
            const reconciledCached = reconcileCloudPeerReadCursors(
              cached,
              accountId,
              peerReadAtByPeerRef.current,
            );
            const merged =
              mergeCloudMessagesByPeerSnapshot(
                reconciledCached,
                current,
                { collapseSelfAccountId: accountId },
              );
            return cloudMessagesByPeerEqual(current, merged)
              ? current
              : merged;
          });
          hydratedCacheAccountRef.current = accountId;
        })
        .catch(() => {});
    }

    const nextSessionActivity = accountId
      ? loadCachedCloudSessionActivity(accountId)
      : EMPTY_CLOUD_SESSION_ACTIVITY;
    sessionActivityRef.current = nextSessionActivity;
    sessionForksByIdRef.current = {};
    sessionPinsByIdRef.current = {};
    sessionTitlesByIdRef.current = {};
    groupSessionTitleBackfillsRef.current.clear();
    agentDefinitionsByIdRef.current = {};
    setSessionActivity(nextSessionActivity);
    setSessionForksById({});
    setSessionPinsById({});
    setSessionTitlesById({});
    setAgentDefinitionsById({});
    const visibility = loadCloudSessionVisibility(accountId);
    hiddenSessionIdsRef.current = visibility.hiddenSessionIds;
    deletedSessionIdsRef.current = visibility.deletedSessionIds;
    setHiddenSessionIds(visibility.hiddenSessionIds);
    setDeletedSessionIds(visibility.deletedSessionIds);

    return () => {
      cancelled = true;
    };
  }, [
    account?.accountId,
    agentDefinitionsByIdRef,
    collaborationStateContextKeyRef,
    collaborationStateRef,
    deletedSessionIdsRef,
    groupReplayCoordinator,
    groupSessionTitleBackfillsRef,
    hiddenSessionIdsRef,
    hydratedCacheAccountRef,
    peerReadAtByPeerRef,
    messageCache,
    messagesByPeerRef,
    messagesCacheAccountRef,
    sessionActivityRef,
    sessionForksByIdRef,
    sessionPinsByIdRef,
    sessionTitlesByIdRef,
    setAgentDefinitionsById,
    setCollaborationOverride,
    setCollaborationOverrideContextKey,
    setDeletedSessionIds,
    setHiddenSessionIds,
    setLocalAgentTurnsByRequestId,
    setMessagesByPeer,
    setPublishedContextKey,
    setReadInboundMessageIdsByPeer,
    setSessionActivity,
    setSessionForksById,
    setSessionPinsById,
    setSessionTitlesById,
    setUnreadReadiness,
    syncCoordinator,
  ]);

  return {
    activity: {
      value: sessionActivity,
      setValue: setSessionActivity,
      valueRef: sessionActivityRef,
    },
    forks: {
      byId: sessionForksById,
      setById: setSessionForksById,
      byIdRef: sessionForksByIdRef,
    },
    pins: {
      byId: sessionPinsById,
      setById: setSessionPinsById,
      byIdRef: sessionPinsByIdRef,
    },
    titles: {
      byId: sessionTitlesById,
      setById: setSessionTitlesById,
      byIdRef: sessionTitlesByIdRef,
      backfillsRef: groupSessionTitleBackfillsRef,
    },
    agents: {
      definitionsById: agentDefinitionsById,
      setDefinitionsById: setAgentDefinitionsById,
      definitionsByIdRef: agentDefinitionsByIdRef,
      sharedByOwner: sharedAgentsByOwner,
      setSharedByOwner: setSharedAgentsByOwner,
    },
    visibility: {
      hiddenSessionIds,
      setHiddenSessionIds,
      hiddenSessionIdsRef,
      deletedSessionIds,
      setDeletedSessionIds,
      deletedSessionIdsRef,
    },
    cancelledRef,
    resetAccountState,
  };
}

export function useCloudSessionVisibilityRefresh({
  account,
  client,
  setHiddenSessionIds,
  setDeletedSessionIds,
}: {
  account: CloudAccount | null;
  client: CloudAuthClient;
  setHiddenSessionIds: Dispatch<SetStateAction<Set<string>>>;
  setDeletedSessionIds: Dispatch<SetStateAction<Set<string>>>;
}) {
  useEffect(() => {
    if (!account) return;
    let cancelled = false;
    void loadSession()
      .then(async (session) => {
        if (!session?.token) return null;
        return client.listSessionVisibility(session.token);
      })
      .then((visibility) => {
        if (cancelled || !visibility) return;
        const nextVisibility = {
          hiddenSessionIds: new Set(
            visibility.hiddenSessionIds
              .map((value) => value.trim())
              .filter(Boolean),
          ),
          deletedSessionIds: new Set(
            visibility.deletedSessionIds
              .map((value) => value.trim())
              .filter(Boolean),
          ),
        };
        saveCloudSessionVisibility(account.accountId, nextVisibility);
        setHiddenSessionIds(nextVisibility.hiddenSessionIds);
        setDeletedSessionIds(nextVisibility.deletedSessionIds);
      })
      .catch(() => {
        // A visibility refresh failure should not block message bootstrap;
        // the next diff/full refresh can recover.
      });
    return () => {
      cancelled = true;
    };
  }, [
    account,
    client,
    setDeletedSessionIds,
    setHiddenSessionIds,
  ]);
}
