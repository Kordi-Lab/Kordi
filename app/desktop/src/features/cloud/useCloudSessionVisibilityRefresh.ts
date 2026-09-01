import { useEffect, type Dispatch, type SetStateAction } from 'react';

import type { CloudAccount, CloudAuthClient } from './authClient';
import { saveCloudSessionVisibility } from './cloudDiffSync';
import { loadSession } from './session';

export function useCloudSessionVisibilityRefresh({
  account,
  client,
  setHiddenSessionIds,
  setDeletedSessionIds,
  setUnreadSessionIds,
  setPinnedSessionIds,
  setMutedSessionIds,
  setPinnedGroupSpaceIds,
}: {
  account: CloudAccount | null;
  client: CloudAuthClient;
  setHiddenSessionIds: Dispatch<SetStateAction<Set<string>>>;
  setDeletedSessionIds: Dispatch<SetStateAction<Set<string>>>;
  setUnreadSessionIds: Dispatch<SetStateAction<Set<string>>>;
  setPinnedSessionIds: Dispatch<SetStateAction<Set<string>>>;
  setMutedSessionIds: Dispatch<SetStateAction<Set<string>>>;
  setPinnedGroupSpaceIds: Dispatch<SetStateAction<Set<string>>>;
}) {
  useEffect(() => {
    if (!account) return;
    let cancelled = false;
    void loadSession()
      .then(async (session) => session?.token
        ? client.listSessionVisibility(session.token)
        : null)
      .then((visibility) => {
        if (cancelled || !visibility) return;
        const ids = (values: string[]) => new Set(
          values.map((value) => value.trim()).filter(Boolean),
        );
        const nextVisibility = {
          hiddenSessionIds: ids(visibility.hiddenSessionIds),
          deletedSessionIds: ids(visibility.deletedSessionIds),
          unreadSessionIds: ids(visibility.unreadSessionIds),
          pinnedSessionIds: ids(visibility.pinnedSessionIds),
          mutedSessionIds: ids(visibility.mutedSessionIds),
          pinnedGroupSpaceIds: ids(visibility.pinnedGroupSpaceIds),
        };
        saveCloudSessionVisibility(account.accountId, nextVisibility);
        setHiddenSessionIds(nextVisibility.hiddenSessionIds);
        setDeletedSessionIds(nextVisibility.deletedSessionIds);
        setUnreadSessionIds(nextVisibility.unreadSessionIds);
        setPinnedSessionIds(nextVisibility.pinnedSessionIds);
        setMutedSessionIds(nextVisibility.mutedSessionIds);
        setPinnedGroupSpaceIds(nextVisibility.pinnedGroupSpaceIds);
      })
      .catch(() => {
        // A visibility refresh failure should not block message bootstrap.
      });
    return () => {
      cancelled = true;
    };
  }, [
    account,
    client,
    setDeletedSessionIds,
    setHiddenSessionIds,
    setMutedSessionIds,
    setPinnedGroupSpaceIds,
    setPinnedSessionIds,
    setUnreadSessionIds,
  ]);
}
