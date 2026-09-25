import {
  isTerminalLoginStatus,
  isTransientLoginError,
  toProviderLoginError,
  type ProviderLoginClient,
  type ProviderLoginSession,
} from './providerLogin';

/** Waits before each retry of a poll that failed transiently; after the last one the failure stands. */
export const LOGIN_POLL_RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000];

function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Long-polls one sign-in until it ends, the signal aborts, or `stopped` says so.
 * The server sends a null version for states it records itself, so `after` only
 * moves forward on numbers. A transient failure, such as OMP restarting or a
 * dropped connection, is retried with backoff; after the last retry it is thrown
 * so the page can offer to try again.
 */
export async function pollProviderLogin(
  client: ProviderLoginClient,
  session: ProviderLoginSession,
  options: {
    signal: AbortSignal;
    onSession: (next: ProviderLoginSession) => void;
    stopped?: () => boolean;
    retryDelaysMs?: readonly number[];
  },
): Promise<void> {
  const { signal } = options;
  const delays = options.retryDelaysMs ?? LOGIN_POLL_RETRY_DELAYS_MS;
  let after = session.version ?? 0;
  let failures = 0;
  while (!signal.aborted && !options.stopped?.()) {
    let next: ProviderLoginSession;
    try {
      next = await client.poll(session.sessionId, after, signal);
    } catch (caught) {
      if (signal.aborted) return;
      const error = toProviderLoginError(caught);
      if (!isTransientLoginError(error) || failures >= delays.length) throw error;
      await pause(delays[failures], signal);
      failures += 1;
      continue;
    }
    failures = 0;
    options.onSession(next);
    if (isTerminalLoginStatus(next.status)) return;
    if (typeof next.version === 'number') after = Math.max(after, next.version);
  }
}
