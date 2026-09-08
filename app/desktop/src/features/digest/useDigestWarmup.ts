import { useEffect } from 'react';

type StoreLoader = () => Promise<Pick<typeof import('./store'), 'digestStoreFor'>>;
const loadStore: StoreLoader = () => import('./store');

// One deferred read after sign-in, then only on foreground transitions. This
// shares the route's store; it never generates a digest or starts another poll.
export function scheduleDigestWarmup(accountId: string, load: StoreLoader = loadStore) {
  let stopped = false;
  let pending = false;
  let lastStarted: number | null = null;
  const warm = async () => {
    if (stopped || document.hidden || pending || (lastStarted !== null && Date.now() - lastStarted < 30_000)) return;
    pending = true;
    lastStarted = Date.now();
    try {
      const { digestStoreFor } = await load();
      if (!stopped) await digestStoreFor(accountId).refresh();
    } catch { /* The route surfaces read failures if the user opens it. */ }
    finally { pending = false; }
  };
  const resume = () => { void warm(); };
  const timer = setTimeout(resume, 0);
  window.addEventListener('focus', resume);
  document.addEventListener('visibilitychange', resume);
  return () => {
    stopped = true;
    clearTimeout(timer);
    window.removeEventListener('focus', resume);
    document.removeEventListener('visibilitychange', resume);
  };
}

export function useDigestWarmup(accountId?: string | null) {
  useEffect(() => accountId ? scheduleDigestWarmup(accountId) : undefined, [accountId]);
}
