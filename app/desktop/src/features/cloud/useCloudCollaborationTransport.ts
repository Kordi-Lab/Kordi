import { useCallback, type Dispatch, type SetStateAction } from 'react';

import type { CanonicalSessionState, Contact } from '@/kordi-app/types';

import type {
  CloudAccount,
  CloudAuthClient,
} from './authClient';
import type { CloudAgentsClient } from './cloudAgentsClient';
import type { CloudSyncCoordinator } from './cloudSyncCoordinator';
import { useCloudAgentAvailability } from './useCloudAgentAvailability';
import { useCloudAgentCatalog } from './useCloudAgentCatalog';
import type {
  useCloudCollaborationStores,
} from './useCloudCollaborationStores';
import { useCloudDirectMessaging } from './useCloudDirectMessaging';
import { useCloudFreshGroupFallbackClaim } from './useCloudFreshGroupFallbackClaim';
import { useCloudMessageSync } from './useCloudMessageSync';
import { deleteCanonicalCloudMessage } from '@/features/canonical/canonicalMessageSources';
import { fetchCanonicalSessionState } from '@/lib/desktop';

type CloudCollaborationStores =
  ReturnType<typeof useCloudCollaborationStores>;

export function useCloudCollaborationTransport({
  account,
  canonicalState,
  setCanonicalState,
  client,
  agentsClient,
  syncCoordinator,
  stores,
  contacts,
  bootstrapPeerIds,
  bootstrapPeerKey,
  unreadContextKey,
  initialContactsSettled,
  initialMessagesSettled,
  reportAvailabilityWarning,
}: {
  account: CloudAccount | null;
  canonicalState?: CanonicalSessionState | null;
  setCanonicalState?: Dispatch<SetStateAction<CanonicalSessionState | null>>;
  client: CloudAuthClient;
  agentsClient: CloudAgentsClient;
  syncCoordinator: CloudSyncCoordinator;
  stores: CloudCollaborationStores;
  contacts: Contact[];
  bootstrapPeerIds: string[];
  bootstrapPeerKey: string;
  unreadContextKey: string | null;
  initialContactsSettled: boolean;
  initialMessagesSettled: boolean;
  reportAvailabilityWarning: (
    message: string,
    error: unknown,
  ) => void;
}) {
  const publishCanonicalDeletion = useCallback(async (deletedMessageIds: string[]) => {
    if (deletedMessageIds.length === 0) return;
    const deletedCanonicalIds = new Set(deletedMessageIds);
    if (setCanonicalState) {
      const refreshed = await fetchCanonicalSessionState().catch(() => null);
      if (refreshed) {
        setCanonicalState(refreshed);
        return;
      }
    }
    setCanonicalState?.((current) => {
      if (!current) return current;
      const messages = current.messages.filter((message) => !deletedCanonicalIds.has(message.id));
      return messages.length === current.messages.length ? current : { ...current, messages };
    });
  }, [setCanonicalState]);
  const onMessagesDeleted = useCallback(async (messageIds: string[]) => {
    if (messageIds.length === 0) return;
    await publishCanonicalDeletion((await Promise.all(
      messageIds.map((messageId) => deleteCanonicalCloudMessage(messageId)),
    )).flat());
  }, [publishCanonicalDeletion]);
  const catalog = useCloudAgentCatalog({
    account,
    client: agentsClient,
    syncCoordinator,
    cancelledRef: stores.cancelledRef,
    stores: {
      definitionsByIdRef: stores.agents.definitionsByIdRef,
      setDefinitionsById: stores.agents.setDefinitionsById,
      sharedByOwner: stores.agents.sharedByOwner,
      setSharedByOwner: stores.agents.setSharedByOwner,
    },
  });
  const { refreshCloudMessages, syncCloudCollaborationDiff } =
    useCloudMessageSync({
      account,
      bootstrapPeerIds,
      bootstrapPeerKey,
      cloudUnreadContextKey: unreadContextKey,
      contactsSettled: initialContactsSettled,
      client,
      coordinator: syncCoordinator,
      cancelledRef: stores.cancelledRef,
      stores: {
        messages: {
          stateRef: stores.messages.byPeerRef,
          setState: stores.messages.setByPeer,
          peerReadAtByPeerRef:
            stores.messages.peerReadAtByPeerRef,
        },
        activity: {
          stateRef: stores.activity.valueRef,
          setState: stores.activity.setValue,
        },
        forks: {
          stateRef: stores.forks.byIdRef,
          setState: stores.forks.setById,
        },
        pins: {
          stateRef: stores.pins.byIdRef,
          setState: stores.pins.setById,
        },
        titles: {
          stateRef: stores.titles.byIdRef,
          setState: stores.titles.setById,
        },
        agents: {
          stateRef: stores.agents.definitionsByIdRef,
          setState: stores.agents.setDefinitionsById,
        },
        hiddenSessionIds: {
          stateRef: stores.visibility.hiddenSessionIdsRef,
          setState: stores.visibility.setHiddenSessionIds,
        },
        deletedSessionIds: {
          stateRef: stores.visibility.deletedSessionIdsRef,
          setState: stores.visibility.setDeletedSessionIds,
        },
        unreadSessionIds: {
          stateRef: stores.visibility.unreadSessionIdsRef,
          setState: stores.visibility.setUnreadSessionIds,
        },
        pinnedSessionIds: {
          stateRef: stores.visibility.pinnedSessionIdsRef,
          setState: stores.visibility.setPinnedSessionIds,
        },
        mutedSessionIds: {
          stateRef: stores.visibility.mutedSessionIdsRef,
          setState: stores.visibility.setMutedSessionIds,
        },
        pinnedGroupSpaceIds: {
          stateRef: stores.visibility.pinnedGroupSpaceIdsRef,
          setState: stores.visibility.setPinnedGroupSpaceIds,
        },
      },
      setUnreadReadiness: stores.unread.setReadiness,
      refreshCloudAgents: catalog.refreshDefinitions,
      onMessagesDeleted,
      onCanonicalMessagesPruned: publishCanonicalDeletion,
    });
  const claimCloudFallbackRun = useCloudAgentAvailability({
    account,
    canonicalSessionState: canonicalState,
    canonicalSessionStateRef: stores.canonicalStateRef,
    setCanonicalSessionState: setCanonicalState,
    client,
    contacts,
    messageIndex: stores.messages.index,
    messageIndexRef: stores.messages.indexRef,
    initialMessagesSettled,
    reportWarning: reportAvailabilityWarning,
  });
  const directMessaging = useCloudDirectMessaging({
    account,
    client,
    messagesByPeerRef: stores.messages.byPeerRef,
    setMessagesByPeer: stores.messages.setByPeer,
    syncDiff: syncCloudCollaborationDiff,
  });
  const claimFreshCloudGroupFallback =
    useCloudFreshGroupFallbackClaim({
      account,
      contacts,
      messagesByPeerRef: stores.messages.byPeerRef,
      claimFallbackRun: claimCloudFallbackRun,
    });

  return {
    catalog,
    refreshCloudMessages,
    syncCloudCollaborationDiff,
    claimFreshCloudGroupFallback,
    ...directMessaging,
  };
}
