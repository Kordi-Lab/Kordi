import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { DIGEST_POLL_INTERVAL, digestStoreFor } from './store';

export function useDigest(accountId: string) {
  const store = digestStoreFor(accountId);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const reload = useCallback(() => store.refresh(true), [store]);
  useEffect(() => {
    let stopped = false;
    let cycle = 0;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const current = ++cycle;
      if (!document.hidden) {
        try { await store.refresh(); } catch { /* Retain content beside the section's error. */ }
      }
      if (!stopped && current === cycle) timer = setTimeout(poll, DIGEST_POLL_INTERVAL);
    };
    const resume = () => {
      if (!document.hidden) { clearTimeout(timer); void poll(); }
    };
    void poll();
    document.addEventListener('visibilitychange', resume);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [store]);
  return { ...state, error: state.digestError ?? state.calendarError, reload };
}
