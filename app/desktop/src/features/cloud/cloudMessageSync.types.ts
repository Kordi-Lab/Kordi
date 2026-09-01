import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import type {
  CloudAccount,
  CloudAuthClient,
  CloudMessage,
  CloudSessionForkSummary,
} from './authClient';
import type { CloudAgentDefinition } from './cloudAgents';
import type {
  CloudSessionPinsById,
  CloudSessionTitlesById,
} from './cloudDiffSync';
import type { CloudSessionActivityStore } from './cloudSessionActivity';
import type { CloudUnreadReadinessSnapshot } from './cloudMessageSyncState';
import type { CloudSyncCoordinator } from './cloudSyncCoordinator';

export type PendingCloudSyncRequest = {
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
  unreadSessionIds: CloudSyncStore<Set<string>>;
  pinnedSessionIds: CloudSyncStore<Set<string>>;
  mutedSessionIds: CloudSyncStore<Set<string>>;
  pinnedGroupSpaceIds: CloudSyncStore<Set<string>>;
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
  onMessagesDeleted?: (messageIds: string[]) => Promise<void> | void;
  onCanonicalMessagesPruned?: (messageIds: string[]) => Promise<void> | void;
};

export type CloudMessageSyncController = {
  refreshCloudMessages: () => Promise<void>;
  syncCloudCollaborationDiff: (
    options?: { settleInitialMessages?: boolean },
  ) => Promise<void>;
};
