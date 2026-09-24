import {
  invokeDesktop,
  openDesktopExternalUrl,
  prepareDesktopCloudOAuthLoopback,
  waitForDesktopCloudOAuthLoopback,
} from '@/lib/desktop';

import {
  CloudAuthError,
  parseCloudOAuthHashResult,
  type CloudAuthClient,
  type CloudAuthResult,
  type CloudOAuthProvider,
} from './authClient';
import {
  throwIfCloudOAuthCancelled,
  waitForCloudOAuthOrCancellation,
} from './cloudOAuthCancellation';

export async function startCloudOAuthSignIn(
  authClient: CloudAuthClient,
  provider: CloudOAuthProvider,
  signal?: AbortSignal,
): Promise<CloudAuthResult | null> {
  let loopback: Awaited<ReturnType<typeof prepareDesktopCloudOAuthLoopback>> = null;
  try {
    throwIfCloudOAuthCancelled(signal);
    loopback = await prepareDesktopCloudOAuthLoopback();
    throwIfCloudOAuthCancelled(signal);
    if (loopback) {
      const result = await waitForCloudOAuthOrCancellation(
        authClient.startOAuth(provider, loopback.redirectUrl), signal,
      );
      throwIfCloudOAuthCancelled(signal);
      await waitForCloudOAuthOrCancellation(openDesktopExternalUrl(result.authUrl), signal);
      throwIfCloudOAuthCancelled(signal);
      const fragment = await waitForCloudOAuthOrCancellation(
        waitForDesktopCloudOAuthLoopback(loopback.requestId), signal,
      );
      throwIfCloudOAuthCancelled(signal);
      const oauthResult = parseCloudOAuthHashResult(fragment);
      if (!oauthResult) {
        throw new CloudAuthError('unknown', 'OAuth sign-in did not return a valid Kordi session.', 0);
      }
      return oauthResult;
    }

    const redirectAfter = typeof window !== 'undefined'
      ? `${window.location.origin}${window.location.pathname}`
      : 'http://127.0.0.1/';
    const result = await waitForCloudOAuthOrCancellation(
      authClient.startOAuth(provider, redirectAfter), signal,
    );
    throwIfCloudOAuthCancelled(signal);
    if (typeof window !== 'undefined') window.location.assign(result.authUrl);
    return null;
  } finally {
    if (loopback) {
      await invokeDesktop<void>('cloud_oauth_loopback_cancel', { requestId: loopback.requestId })
        .catch(() => undefined);
    }
  }
}
