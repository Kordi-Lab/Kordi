import { CloudAuthError } from './cloudAuthError';
import {
  clearSessionAndNotifySignedOut,
  loadSession,
  notifyCloudSessionSignedOut,
  refreshSession,
} from './session';

/**
 * Whether the server no longer accepts the session: it expired, was revoked,
 * or the server's data was reset. Network errors, 5xx and 429 are transient.
 */
export function isCloudSessionRejected(error: unknown): boolean {
  return error instanceof CloudAuthError && error.status === 401 && error.code === 'invalid_session';
}

let ending: { token: string; promise: Promise<boolean> } | null = null;

/**
 * Settles a session the server rejected, once however many checks report it.
 * A browser sign-in first tries its refresh token. Otherwise, or when the
 * refresh token is refused too, the saved session is cleared and the app
 * shows sign-in. A session that changed since `token` was read, such as a new
 * sign-in or a refresh, is left alone.
 *
 * Resolves true when the session ended, false when it is still usable or the
 * refresh could not reach the server (callers retry later).
 */
export function endRejectedCloudSession(token: string): Promise<boolean> {
  if (ending?.token === token) return ending.promise;
  const promise = (async () => {
    const current = await loadSession();
    if (!current) {
      notifyCloudSessionSignedOut();
      return true;
    }
    if (current.token !== token) return false;
    if (current.refreshToken) {
      // Null means the refresh token was refused and the session is already cleared.
      return (await refreshSession(current)) === null;
    }
    await clearSessionAndNotifySignedOut();
    return true;
  })().finally(() => {
    if (ending?.promise === promise) ending = null;
  });
  ending = { token, promise };
  return promise;
}

/** Ends the session `token` named when `error` says the server rejected it; other errors are ignored. */
export function endCloudSessionIfRejected(token: string, error: unknown): void {
  if (token && isCloudSessionRejected(error)) void endRejectedCloudSession(token).catch(() => undefined);
}
