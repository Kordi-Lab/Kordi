import {
  useEffect,
  useRef,
} from 'react';
import type {
  CloudAccount,
} from './authClient';
import {
  CLOUD_FOCUS_REFRESH_DELAY_MS,
  shouldRefreshCloudForVisibility,
  shouldRunCloudFocusRefresh,
} from './cloudMessageSyncState';
import type {
  CloudMessageSyncController,
} from './useCloudMessageSync';

type SyncCloudCollaborationDiff =
  CloudMessageSyncController['syncCloudCollaborationDiff'];

export function useCloudFocusRefresh({
  account,
  syncCloudCollaborationDiff,
}: {
  account: CloudAccount | null;
  syncCloudCollaborationDiff: SyncCloudCollaborationDiff;
}) {
  const lastRefreshAtRef = useRef(0);
  const refreshTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!account) return;
    const runRefresh = () => {
      refreshTimerRef.current = null;
      const now = Date.now();
      if (
        !shouldRunCloudFocusRefresh(
          now,
          lastRefreshAtRef.current,
        )
      ) return;
      lastRefreshAtRef.current = now;
      void syncCloudCollaborationDiff();
    };
    const refresh = () => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
      }
      refreshTimerRef.current = window.setTimeout(
        runRefresh,
        CLOUD_FOCUS_REFRESH_DELAY_MS,
      );
    };
    const refreshWhenVisible = () => {
      if (
        typeof document === 'undefined'
        || shouldRefreshCloudForVisibility(
          document.visibilityState,
        )
      ) refresh();
    };
    window.addEventListener('focus', refresh);
    window.addEventListener('pageshow', refreshWhenVisible);
    document.addEventListener(
      'visibilitychange',
      refreshWhenVisible,
    );
    return () => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      window.removeEventListener('focus', refresh);
      window.removeEventListener('pageshow', refreshWhenVisible);
      document.removeEventListener(
        'visibilitychange',
        refreshWhenVisible,
      );
    };
  }, [account, syncCloudCollaborationDiff]);
}
