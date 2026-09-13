import { useCallback, useEffect, useRef } from 'react';
import { CLOUD_MESSAGES_REFRESH_MS, CLOUD_DESKTOP_EXECUTION_REFRESH_MS, createCloudRepairPolling } from './cloudRepairPolling';

export function useCloudRepairPolling(
  accountId: string | undefined,
  enabled: boolean,
  sync: () => Promise<void>,
  desktopExecutionEnabled = false,
) {
  const pollingRef = useRef<ReturnType<typeof createCloudRepairPolling> | null>(null);
  const syncRef = useRef(sync);
  useEffect(() => { syncRef.current = sync; }, [sync]);
  useEffect(() => {
    const polling = createCloudRepairPolling();
    pollingRef.current = polling;
    if (!accountId || !enabled) return;
    const timer = window.setInterval(() => {
      void polling.poll(document.visibilityState === 'hidden', () => syncRef.current(), desktopExecutionEnabled);
    }, desktopExecutionEnabled ? CLOUD_DESKTOP_EXECUTION_REFRESH_MS : CLOUD_MESSAGES_REFRESH_MS);
    return () => {
      window.clearInterval(timer);
      pollingRef.current = null;
    };
  }, [accountId, enabled, desktopExecutionEnabled]);
  return useCallback((connected: boolean) => {
    pollingRef.current?.setRealtimeConnected(connected);
  }, []);
}
