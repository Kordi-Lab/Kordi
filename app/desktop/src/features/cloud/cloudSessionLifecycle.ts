import type { CloudAuthClient } from './authClient';
import { CloudAuthError, cloudOAuthCallbackError } from './cloudAuthError';
import { browserSessionAccountId, isBrowserAppRuntime } from '@web/auth/browserAppRuntime';
import { parseCloudOAuthHashError } from './cloudOAuthResult';
import { revokeAppSignIn } from './appSignIn/appSignInClient';
import { cloudFetchImpl } from './cloudTransport';
import { clearSessionAndNotifySignedOut, loadSession } from './session';
import { publishPresenceOffline } from './useCloudPresencePublisher';

export function consumeBrowserSignInError(publish: (error: CloudAuthError) => void): boolean {
  if (!isBrowserAppRuntime()) return false;
  const error = parseCloudOAuthHashError(window.location.hash);
  if (!error) return false;
  window.history.replaceState(null, document.title, `${window.location.pathname}${window.location.search}`);
  publish(cloudOAuthCallbackError(error.code, error.message));
  return true;
}

export function browserSessionRestoreError(): CloudAuthError | null {
  return isBrowserAppRuntime() ? new CloudAuthError(
    'network_error', 'Could not restore your browser session. Check your connection and reload.', 0,
  ) : null;
}

/** Cookie logout must succeed before hiding the account; native logout keeps its offline behavior. */
export async function signOutCloudSession(authClient: CloudAuthClient): Promise<void> {
  const browserSession = isBrowserAppRuntime() ? await loadSession() : null;
  if (browserSession && browserSessionAccountId(browserSession.token)) {
    await authClient.logout(browserSession.token);
    await clearSessionAndNotifySignedOut();
    return;
  }
  try {
    const stored = await loadSession();
    if (stored) {
      try {
        await publishPresenceOffline(authClient);
      } catch {
        // Presence is best-effort; the account can still sign out offline.
      }
      try {
        if (!(await revokeAppSignIn(stored, cloudFetchImpl()))) await authClient.logout(stored.token);
      } catch {
        // Native credentials can still be removed locally while the server is unreachable.
      }
    }
  } finally {
    await clearSessionAndNotifySignedOut();
  }
}
