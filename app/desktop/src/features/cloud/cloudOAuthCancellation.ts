export class CloudOAuthCancelledError extends Error {
  constructor() {
    super('Social sign-in was canceled.');
    this.name = 'CloudOAuthCancelledError';
  }
}

export function isCloudOAuthCancelled(error: unknown): error is CloudOAuthCancelledError {
  return error instanceof CloudOAuthCancelledError;
}

export function throwIfCloudOAuthCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CloudOAuthCancelledError();
}

export function waitForCloudOAuthOrCancellation<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(new CloudOAuthCancelledError());

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(new CloudOAuthCancelledError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
