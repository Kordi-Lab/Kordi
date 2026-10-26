/** Waits before each retry of a failed personal agents load; the last one repeats until it succeeds. */
export const PERSONAL_AGENT_RETRY_DELAYS_MS: readonly number[] = [5_000, 30_000, 120_000];

type EventSource = Pick<Window, 'addEventListener' | 'removeEventListener'>;

/**
 * Runs `load` until it succeeds: after a failure it waits 5 s, 30 s, then
 * every 2 min, and tries again at once when the window regains focus, comes
 * back online, or becomes visible. Returns a stop function.
 */
export function loadUntilSuccess(load: () => Promise<boolean>, {
  onError,
  delaysMs = PERSONAL_AGENT_RETRY_DELAYS_MS,
  windowTarget = typeof window === 'undefined' ? null : window,
  documentTarget = typeof document === 'undefined' ? null : document,
}: {
  /** Called for each failed attempt. */
  onError: (error: unknown) => void;
  delaysMs?: readonly number[];
  windowTarget?: EventSource | null;
  documentTarget?: (EventSource & Pick<Document, 'visibilityState'>) | null;
}) {
  let stopped = false;
  let succeeded = false;
  let running = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = async () => {
    if (stopped || succeeded || running) return;
    running = true;
    clearTimeout(timer);
    try {
      // `false` means there is nothing to load for now (signed out); it is not retried.
      succeeded = await load();
    } catch (error) {
      if (stopped) return;
      onError(error);
      const delay = delaysMs[Math.min(failures, delaysMs.length - 1)] ?? 120_000;
      failures += 1;
      timer = setTimeout(() => { void attempt(); }, delay);
    } finally {
      running = false;
    }
  };
  const retryNow = () => {
    if (!succeeded && documentTarget?.visibilityState !== 'hidden') void attempt();
  };
  windowTarget?.addEventListener('focus', retryNow);
  windowTarget?.addEventListener('online', retryNow);
  documentTarget?.addEventListener('visibilitychange', retryNow);
  void attempt();
  return () => {
    stopped = true;
    clearTimeout(timer);
    windowTarget?.removeEventListener('focus', retryNow);
    windowTarget?.removeEventListener('online', retryNow);
    documentTarget?.removeEventListener('visibilitychange', retryNow);
  };
}
