import { applyCloudSyncEventsToSessionVisibility, hasCachedCloudSessionVisibility, saveCloudSessionVisibility } from './cloudDiffSync';
import { cloudSetsEqual } from './cloudMessageSyncState';
import type { CloudSyncEvent } from './authClient';
import type { CloudMessageSyncStores } from './cloudMessageSync.types';

const keys = ['hiddenSessionIds', 'deletedSessionIds', 'unreadSessionIds', 'pinnedSessionIds', 'mutedSessionIds', 'pinnedGroupSpaceIds'] as const;

/** Publish visibility before a native batch can announce its new conversations. */
export function commitCloudVisibility(accountId: string, stores: CloudMessageSyncStores, events: CloudSyncEvent[]) {
  if (!events.some(event => event.eventType === 'session.visibility.snapshot') && !hasCachedCloudSessionVisibility(accountId)) return;
  const current = {
    hiddenSessionIds: stores.hiddenSessionIds.stateRef.current,
    deletedSessionIds: stores.deletedSessionIds.stateRef.current,
    unreadSessionIds: stores.unreadSessionIds.stateRef.current,
    pinnedSessionIds: stores.pinnedSessionIds.stateRef.current,
    mutedSessionIds: stores.mutedSessionIds.stateRef.current,
    pinnedGroupSpaceIds: stores.pinnedGroupSpaceIds.stateRef.current,
  };
  const next = applyCloudSyncEventsToSessionVisibility(accountId, current, events);
  saveCloudSessionVisibility(accountId, next);
  for (const key of keys) {
    stores[key].stateRef.current = next[key];
    stores[key].setState(previous => cloudSetsEqual(previous, next[key]) ? previous : next[key]);
  }
}
