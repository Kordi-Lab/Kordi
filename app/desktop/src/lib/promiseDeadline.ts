// Bounds for long-lived loops that await native or network work.
//
// A webview reload, a lost native reply, or a stalled response body can leave
// a promise pending forever. A loop that serializes on such a promise (a
// heartbeat chain, a single-flight lock) then stops for the rest of the
// session without reporting anything. These helpers let the caller settle on
// its own deadline or abort signal while the abandoned work finishes, or not,
// in the background.

export class PromiseDeadlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromiseDeadlineError';
  }
}

/** Rejects with a PromiseDeadlineError when `promise` has not settled after `ms`. */
export function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new PromiseDeadlineError(message));
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Settles with `promise`, or rejects with `abortError()` as soon as `signal`
 * aborts. A value that arrives after the abort is handed to `onAbandoned` so
 * the caller can release whatever it holds.
 */
export function untilAborted<T>(
  promise: Promise<T>,
  signal: AbortSignal | null | undefined,
  abortError: () => Error,
  onAbandoned?: (value: T) => void,
): Promise<T> {
  if (!signal) return promise;
  // The first of the value and the abort decides the outcome; a value that
  // loses is released instead of being dropped.
  let winner: 'value' | 'abort' | null = null;
  const settled = promise.then((value) => {
    if (winner === null) winner = 'value';
    else onAbandoned?.(value);
    return value;
  });
  let onAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      if (winner !== null) return;
      winner = 'abort';
      reject(abortError());
    };
  });
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  return Promise.race([settled, aborted]).finally(() => signal.removeEventListener('abort', onAbort));
}
