import {
  openDesktopExternalUrl,
  waitForDesktopCloudOAuthLoopback,
  type DesktopCloudOAuthLoopbackStart,
} from '@/lib/desktop';

import {
  CloudAuthError,
  parseCloudOAuthHashError,
  parseCloudOAuthHashResult,
  type CloudAuthClient,
  type CloudAuthResult,
  type CloudOAuthProvider,
} from './authClient';

export async function completeDesktopCloudOAuthLoopback(
  client: CloudAuthClient,
  provider: CloudOAuthProvider,
  loopback: DesktopCloudOAuthLoopbackStart,
): Promise<CloudAuthResult> {
  const result = await client.startOAuth(provider, loopback.redirectUrl);
  await openDesktopExternalUrl(result.authUrl);
  const fragment = await waitForDesktopCloudOAuthLoopback(loopback.requestId);
  const oauthError = parseCloudOAuthHashError(fragment);
  if (oauthError) throw new CloudAuthError('unknown', oauthError, 0);
  const oauthResult = parseCloudOAuthHashResult(fragment);
  if (!oauthResult) {
    throw new CloudAuthError('unknown', 'OAuth sign-in did not return a valid Kordi session.', 0);
  }
  return oauthResult;
}
