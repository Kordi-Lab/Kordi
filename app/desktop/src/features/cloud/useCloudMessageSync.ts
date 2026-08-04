import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import type {
  CloudAccount,
  CloudAuthClient,
  CloudMessage,
  CloudSessionForkSummary,
} from './authClient';
import type { CloudAgentDefinition } from './cloudAgents';
import {
  cloudMessageMetadataOnly,
} from './cloudMessageCache';
import {
  cloudSessionForksByIdEqual,
  cloudMessagesByPeerEqual,
  cloudUnreadReadinessContextKey,
  loadCloudMessagesByPeerUntilStable,
  mergeCloudPeerReadCursors,
  mergeCloudMessagesByPeerSnapshot,
  reconcileCloudPeerReadCursors,
  transitionCloudUnreadReadiness,
  type CloudUnreadReadinessSnapshot,
  type CloudUnreadReadinessStatus,
} from './cloudMessageSyncState';
import {
  syncCloudDiffOnce,
  type CloudSessionPinsById,
  type CloudSessionTitlesById,
} from './cloudDiffSync';
import {
  mergeCloudSessionActivity,
  type CloudSessionActivityStore,
} from './cloudSessionActivity';
import { CloudSyncCoordinator } from './cloudSyncCoordinator';
import { loadSession } from './session';

// Realtime messages normally arrive through the Cloud WebSocket. This interval
// is only a repair path for a missed frame or a temporarily disconnected
// socket, so polling it several times per second adds load without improving
// the normal delivery path.
export const CLOUD_MESSAGES_REFRESH_MS = 15_000;
const CLOUD_MESSAGE_SNAPSHOT_LIMIT = 500;
const CLOUD_SYNC_EVENT_PAGE_LIMIT = 1_000;

type PendingCloudSyncRequest = {
  mode: 'diff' | 'full' | 'bootstrap';
  settleInitialMessages: boolean;
};

type CloudSyncStore<T> = {
  stateRef: MutableRefObject<T>;
  setState: Dispatch<SetStateAction<T>>;
};

export type CloudMessageSyncStores = {
  messages: CloudSyncStore<Record<string, CloudMessage[]>> & {
    peerReadAtByPeerRef: MutableRefObject<Record<string, string>>;
  };
  activity: CloudSyncStore<CloudSessionActivityStore>;
  forks: CloudSyncStore<Record<string, CloudSessionForkSummary>>;
  pins: CloudSyncStore<CloudSessionPinsById>;
  titles: CloudSyncStore<CloudSessionTitlesById>;
  agents: CloudSyncStore<Record<string, CloudAgentDefinition>>;
  hiddenSessionIds: CloudSyncStore<Set<string>>;
  deletedSessionIds: CloudSyncStore<Set<string>>;
};

export type UseCloudMessageSyncInput = {
  account: CloudAccount | null;
  bootstrapPeerIds: string[];
  bootstrapPeerKey: string;
  cloudUnreadContextKey: string | null;
  contactsSettled: boolean;
  client: CloudAuthClient;
  coordinator: CloudSyncCoordinator;
  cancelledRef: MutableRefObject<boolean>;
  stores: CloudMessageSyncStores;
  setUnreadReadiness: Dispatch<SetStateAction<CloudUnreadReadinessSnapshot>>;
  refreshCloudAgents: (generation?: number) => Promise<void>;
};

export type CloudMessageSyncController = {
  refreshCloudMessages: () => Promise<void>;
  syncCloudCollaborationDiff: (
    options?: { settleInitialMessages?: boolean },
  ) => Promise<void>;
};

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

export function useCloudMessageSync({
  account,
  bootstrapPeerIds,
  bootstrapPeerKey,
  cloudUnreadContextKey,
  contactsSettled,
  client,
  coordinator,
  cancelledRef,
  stores,
  setUnreadReadiness,
  refreshCloudAgents,
}: UseCloudMessageSyncInput): CloudMessageSyncController {
  const {
    stateRef: messagesRef,
    setState: setMessages,
    peerReadAtByPeerRef,
  } = stores.messages;
  const { stateRef: activityRef, setState: setActivity } = stores.activity;
  const { stateRef: forksRef, setState: setForks } = stores.forks;
  const { stateRef: pinsRef, setState: setPins } = stores.pins;
  const { stateRef: titlesRef, setState: setTitles } = stores.titles;
  const { stateRef: agentsRef, setState: setAgents } = stores.agents;
  const {
    stateRef: hiddenSessionIdsRef,
    setState: setHiddenSessionIds,
  } = stores.hiddenSessionIds;
  const {
    stateRef: deletedSessionIdsRef,
    setState: setDeletedSessionIds,
  } = stores.deletedSessionIds;
  const bootstrapPeerIdsRef = useRef<string[]>(bootstrapPeerIds);
  const pendingRequestRef = useRef<PendingCloudSyncRequest | null>(null);
  const startupSnapshotContextRef = useRef<string | null>(null);

  useEffect(() => {
    bootstrapPeerIdsRef.current = bootstrapPeerIds;
  }, [bootstrapPeerIds]);

  useEffect(() => {
    pendingRequestRef.current = null;
    startupSnapshotContextRef.current = null;
  }, [account?.accountId, coordinator]);

  const markUnreadReadiness = useCallback((
    status: CloudUnreadReadinessStatus,
    generation: number,
    peerKey: string,
  ) => {
    const accountId = account?.accountId;
    if (!accountId || !coordinator.isCurrentGeneration(generation)) return;
    const contextKey = cloudUnreadReadinessContextKey(accountId, generation, peerKey);
    setUnreadReadiness((current) => transitionCloudUnreadReadiness(
      current,
      status,
      contextKey,
    ));
  }, [account?.accountId, coordinator, setUnreadReadiness]);

  const refreshMessagesOnce = useCallback(async (
    generation: number,
    settleUnreadReadiness: boolean = true,
    publishMessages: boolean = true,
  ) => {
    if (!coordinator.isCurrentGeneration(generation)) return;
    const retainedPeerIds = Object.keys(messagesRef.current);
    const initialPeerIds = [...new Set([...bootstrapPeerIdsRef.current, ...retainedPeerIds])];
    if (!account || initialPeerIds.length === 0) {
      if (!coordinator.isCurrentGeneration(generation)) return;
      messagesRef.current = {};
      if (publishMessages) {
        setMessages((current) => (
          Object.keys(current).length === 0 ? current : {}
        ));
      }
      if (settleUnreadReadiness) {
        markUnreadReadiness('ready', generation, bootstrapPeerKey);
      }
      return;
    }
    const session = await loadSession();
    if (!coordinator.isCurrentGeneration(generation)) return;
    if (!session?.token) {
      if (settleUnreadReadiness) {
        markUnreadReadiness('error', generation, bootstrapPeerKey);
      }
      return;
    }

    const fetchedPeerReadAtByPeer: Record<string, string | null> = {};
    const loaded = await loadCloudMessagesByPeerUntilStable({
      accountId: account.accountId,
      initialPeerIds,
      existingMessagesByPeer: messagesRef.current,
      listMessages: async (peerId) => {
        const snapshot = await client.listMessageSnapshot(
          session.token,
          peerId,
          CLOUD_MESSAGE_SNAPSHOT_LIMIT,
        );
        fetchedPeerReadAtByPeer[peerId] = snapshot.peerReadAt;
        return snapshot.messages.map(cloudMessageMetadataOnly);
      },
    });

    if (cancelledRef.current || !coordinator.isCurrentGeneration(generation)) return;
    peerReadAtByPeerRef.current = mergeCloudPeerReadCursors(
      peerReadAtByPeerRef.current,
      fetchedPeerReadAtByPeer,
    );
    const reconcileReadState = (
      current: Record<string, CloudMessage[]>,
    ) => reconcileCloudPeerReadCursors(
      current,
      account.accountId,
      peerReadAtByPeerRef.current,
    );
    messagesRef.current = mergeCloudMessagesByPeerSnapshot(
      reconcileReadState(messagesRef.current),
      loaded.messagesByPeer,
    );
    if (publishMessages) {
      setMessages((current) => {
        const merged = mergeCloudMessagesByPeerSnapshot(
          reconcileReadState(current),
          loaded.messagesByPeer,
        );
        return cloudMessagesByPeerEqual(current, merged) ? current : merged;
      });
    }
    if (settleUnreadReadiness) {
      markUnreadReadiness(
        loaded.complete ? 'ready' : 'error',
        generation,
        bootstrapPeerKey,
      );
    }
  }, [
    account,
    bootstrapPeerKey,
    cancelledRef,
    client,
    coordinator,
    markUnreadReadiness,
    messagesRef,
    peerReadAtByPeerRef,
    setMessages,
  ]);

  const syncDiffOnceForGeneration = useCallback(async (
    generation: number,
    settleInitialMessages: boolean,
  ) => {
    if (!account || !coordinator.isCurrentGeneration(generation)) return;
    const session = await loadSession();
    if (!coordinator.isCurrentGeneration(generation)) return;
    if (!session?.token) {
      if (settleInitialMessages) {
        markUnreadReadiness('error', generation, bootstrapPeerKey);
      }
      return;
    }
    let messagesByPeer = messagesRef.current;
    let sessionActivity = activityRef.current;
    let sessionForksById = forksRef.current;
    let sessionPinsById = pinsRef.current;
    let sessionTitlesById = titlesRef.current;
    let cloudAgentsById = agentsRef.current;
    let hiddenSessionIds = hiddenSessionIdsRef.current;
    let deletedSessionIds = deletedSessionIdsRef.current;
    let fallbackRequired = false;
    // A bootstrap cursor can be many pages behind the server (especially on a
    // fresh install). Keep the accumulated state private until the cursor is
    // exhausted so the sidebar never publishes a succession of partial
    // session catalogs and message counts.
    while (true) {
      const result = await syncCloudDiffOnce({
        accountId: account.accountId,
        messagesByPeer,
        sessionActivity,
        sessionForksById,
        sessionPinsById,
        sessionTitlesById,
        cloudAgentsById,
        hiddenSessionIds,
        deletedSessionIds,
        shouldSaveCursor: () => coordinator.isCurrentGeneration(generation),
        fetchEvents: (cursor) => client.syncCloudEvents(
          session.token,
          cursor,
          CLOUD_SYNC_EVENT_PAGE_LIMIT,
        ),
      });
      if (!coordinator.isCurrentGeneration(generation)) return;
      if (result.fallbackRequired) {
        fallbackRequired = true;
        break;
      }
      messagesByPeer = result.messagesByPeer;
      sessionActivity = result.sessionActivity;
      sessionForksById = result.sessionForksById;
      sessionPinsById = result.sessionPinsById;
      sessionTitlesById = result.sessionTitlesById;
      cloudAgentsById = result.cloudAgentsById;
      hiddenSessionIds = result.hiddenSessionIds;
      deletedSessionIds = result.deletedSessionIds;
      if (!result.hasMore) break;
    }
    if (cancelledRef.current || !coordinator.isCurrentGeneration(generation)) return;
    if (fallbackRequired) {
      await Promise.all([
        refreshMessagesOnce(generation, settleInitialMessages),
        refreshCloudAgents(generation),
      ]);
      return;
    }
    messagesRef.current = mergeCloudMessagesByPeerSnapshot(
      messagesRef.current,
      messagesByPeer,
    );
    setMessages((current) => {
      const merged = mergeCloudMessagesByPeerSnapshot(current, messagesByPeer);
      if (cloudMessagesByPeerEqual(current, merged)) return current;
      return merged;
    });
    setActivity((current) => mergeCloudSessionActivity(current, sessionActivity));
    setForks((current) => (
      cloudSessionForksByIdEqual(current, sessionForksById) ? current : sessionForksById
    ));
    setPins((current) => (
      JSON.stringify(current) === JSON.stringify(sessionPinsById) ? current : sessionPinsById
    ));
    setTitles((current) => (
      JSON.stringify(current) === JSON.stringify(sessionTitlesById) ? current : sessionTitlesById
    ));
    setAgents((current) => (
      JSON.stringify(current) === JSON.stringify(cloudAgentsById) ? current : cloudAgentsById
    ));
    setHiddenSessionIds((current) => (
      setsEqual(current, hiddenSessionIds) ? current : new Set(hiddenSessionIds)
    ));
    setDeletedSessionIds((current) => (
      setsEqual(current, deletedSessionIds) ? current : new Set(deletedSessionIds)
    ));
  }, [
    account,
    activityRef,
    agentsRef,
    bootstrapPeerKey,
    cancelledRef,
    client,
    coordinator,
    deletedSessionIdsRef,
    forksRef,
    hiddenSessionIdsRef,
    markUnreadReadiness,
    messagesRef,
    pinsRef,
    refreshCloudAgents,
    refreshMessagesOnce,
    setActivity,
    setAgents,
    setDeletedSessionIds,
    setForks,
    setHiddenSessionIds,
    setMessages,
    setPins,
    setTitles,
    titlesRef,
  ]);

  const runCoordinatedSync = useCallback(async (generation: number) => {
    const request = pendingRequestRef.current;
    pendingRequestRef.current = null;
    if (!request) return;
    try {
      if (request.mode === 'bootstrap') {
        // Establish the newest server state before replaying historical events,
        // then publish unread state only after the final authoritative snapshot.
        await refreshMessagesOnce(generation, false, false);
        await syncDiffOnceForGeneration(generation, false);
        await refreshMessagesOnce(generation, true);
      } else if (request.mode === 'full') {
        await refreshMessagesOnce(generation);
      } else {
        await syncDiffOnceForGeneration(generation, request.settleInitialMessages);
      }
    } catch (error) {
      if (request.mode !== 'diff' || request.settleInitialMessages) {
        markUnreadReadiness('error', generation, bootstrapPeerKey);
      }
      throw error;
    }
  }, [
    bootstrapPeerKey,
    markUnreadReadiness,
    refreshMessagesOnce,
    syncDiffOnceForGeneration,
  ]);

  const requestSync = useCallback((request: PendingCloudSyncRequest) => {
    const pending = pendingRequestRef.current;
    const mode = pending?.mode === 'bootstrap' || request.mode === 'bootstrap'
      ? 'bootstrap'
      : pending?.mode === 'full' || request.mode === 'full'
        ? 'full'
        : 'diff';
    const nextRequest = {
      mode,
      settleInitialMessages: Boolean(
        pending?.settleInitialMessages || request.settleInitialMessages,
      ),
    } satisfies PendingCloudSyncRequest;
    pendingRequestRef.current = nextRequest;
    if (nextRequest.mode !== 'diff') {
      markUnreadReadiness(
        'pending',
        coordinator.currentGeneration(),
        bootstrapPeerKey,
      );
    }
    return coordinator.request(runCoordinatedSync);
  }, [bootstrapPeerKey, coordinator, markUnreadReadiness, runCoordinatedSync]);

  const refreshCloudMessages = useCallback(() => requestSync({
    mode: 'full',
    settleInitialMessages: true,
  }), [requestSync]);

  const bootstrapCloudMessages = useCallback(() => requestSync({
    mode: 'bootstrap',
    settleInitialMessages: true,
  }), [requestSync]);

  const syncCloudCollaborationDiff = useCallback((
    options: { settleInitialMessages?: boolean } = {},
  ) => requestSync({
    mode: 'diff',
    settleInitialMessages: options.settleInitialMessages ?? true,
  }), [requestSync]);

  useEffect(() => {
    if (!account || !contactsSettled || !cloudUnreadContextKey) return;
    if (startupSnapshotContextRef.current !== cloudUnreadContextKey) {
      startupSnapshotContextRef.current = cloudUnreadContextKey;
      void refreshCloudAgents(coordinator.currentGeneration());
      void bootstrapCloudMessages().catch(() => {
        if (startupSnapshotContextRef.current === cloudUnreadContextKey) {
          startupSnapshotContextRef.current = null;
        }
      });
    }
    const interval = window.setInterval(() => {
      if (
        typeof document !== 'undefined'
        && document.visibilityState !== 'visible'
      ) return;
      void syncCloudCollaborationDiff();
    }, CLOUD_MESSAGES_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [
    account,
    bootstrapCloudMessages,
    cloudUnreadContextKey,
    contactsSettled,
    coordinator,
    refreshCloudAgents,
    syncCloudCollaborationDiff,
  ]);

  return {
    refreshCloudMessages,
    syncCloudCollaborationDiff,
  };
}
