import { useCallback, useLayoutEffect, useRef } from 'react';

export type CloudSyncPresentation = {
  status: 'syncing' | 'error' | 'ready';
  onRetry: () => void;
};

export function useCloudSyncPresentation(
  sync: CloudSyncPresentation,
  onChange: (sync: CloudSyncPresentation) => void,
) {
  const retryRef = useRef(sync.onRetry);
  useLayoutEffect(() => { retryRef.current = sync.onRetry; }, [sync.onRetry]);
  const retry = useCallback(() => retryRef.current(), []);
  // Retry dependencies can change on every model render. Report only a real
  // status change; otherwise the parent update re-renders this model forever.
  useLayoutEffect(() => {
    onChange({ status: sync.status, onRetry: retry });
  }, [sync.status, retry, onChange]);
}
