// HTTP side of browser sign-in. The contract lives in
// docs/development/browser-sign-in.md: the app opens the authorize URL in the
// system browser, receives a one-time code on its loopback redirect (or the
// user pastes a displayed code), and exchanges it here with its PKCE verifier.

import type { CloudAccount, CloudAuthResult } from '../authClient';
import { CloudAuthError, rateLimitedMessage } from '../cloudAuthError';
import { clientDistribution } from '../distribution';
import type { CloudDeviceRegistration } from '../deviceIdentity';
import type { StoredSession } from '../session';

export const APP_AUTHORIZE_PATH = '/v1/cloud/auth/app/authorize';
export const APP_TOKEN_PATH = '/v1/cloud/auth/app/token';
export const APP_REVOKE_PATH = '/v1/cloud/auth/app/revoke';

export type BrowserSignInIntent = 'login' | 'signup';

/** Fields a browser sign-in adds to the stored session so it can refresh. */
export type AppSignInRefresh = Required<Pick<StoredSession, 'refreshToken' | 'clientId' | 'tokenEndpoint'>>;
export type AppSignInResult = CloudAuthResult & { refresh: AppSignInRefresh };

type FetchLike = typeof fetch;
type AppClientEnvironment = { VITE_KORDI_APP_CLIENT_ID?: string };

function cleanBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function readEnvironment(): AppClientEnvironment | undefined {
  return typeof import.meta !== 'undefined'
    ? (import.meta as ImportMeta & { env?: AppClientEnvironment }).env
    : undefined;
}

/**
 * The registered public client for this build. Each distribution has its own
 * callback scheme (`kordi`, `kordi-beta`, `kordi-staging`, ...) and the server
 * registers a matching desktop client (`kordi-desktop`, `kordi-desktop-beta`,
 * `kordi-desktop-staging`, ...).
 */
export function appSignInClientId(
  callbackScheme: string | undefined = clientDistribution()?.callbackScheme,
  env: AppClientEnvironment | undefined = readEnvironment(),
): string {
  const override = env?.VITE_KORDI_APP_CLIENT_ID?.trim();
  if (override) return override;
  const scheme = callbackScheme?.trim().toLowerCase() || 'kordi';
  if (scheme === 'kordi') return 'kordi-desktop';
  return scheme.startsWith('kordi-') ? `kordi-desktop-${scheme.slice('kordi-'.length)}` : `${scheme}-desktop`;
}

export function appTokenEndpoint(baseUrl: string): string {
  return `${cleanBaseUrl(baseUrl)}${APP_TOKEN_PATH}`;
}

export function buildAppAuthorizeUrl({
  baseUrl,
  clientId,
  redirectUri,
  codeChallenge,
  state,
  intent,
}: {
  baseUrl: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  intent: BrowserSignInIntent;
}): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });
  // OpenID Connect `prompt=create` asks the page to open on account creation.
  if (intent === 'signup') params.set('prompt', 'create');
  return `${cleanBaseUrl(baseUrl)}${APP_AUTHORIZE_PATH}?${params.toString()}`;
}

export type BrowserSignInAvailability = 'available' | 'unavailable' | 'unknown';

/**
 * Asks whether this server offers browser sign-in for this app. A request
 * without a redirect URI is refused before any redirect: a server that knows
 * the client answers `invalid_redirect_uri`; an older server has no route
 * (404 or 405) and a server without this client answers `invalid_client`.
 * Any other answer is `unknown`.
 */
export async function probeBrowserSignIn({
  baseUrl,
  clientId,
  fetchImpl,
  timeoutMs = 6_000,
}: {
  baseUrl: string;
  clientId: string;
  fetchImpl: FetchLike;
  timeoutMs?: number;
}): Promise<BrowserSignInAvailability> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${cleanBaseUrl(baseUrl)}${APP_AUTHORIZE_PATH}?${new URLSearchParams({ client_id: clientId })}`;
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'manual',
      signal: controller.signal,
    });
    if (response.status === 404 || response.status === 405) return 'unavailable';
    const body = await readJson(response);
    const error = oauthErrorCode(body);
    if (error === 'invalid_redirect_uri') return 'available';
    if (error === 'invalid_client') return 'unavailable';
    // Rate limits, proxies, captive portals and outages say nothing about
    // the server's support; ask again next time.
    return 'unknown';
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function oauthErrorCode(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const value = record.error ?? record.errorCode;
  return typeof value === 'string' ? value : null;
}

function oauthErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const value = record.message ?? record.error_description;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Reads the loopback callback query. Returns the code, or throws the error
 * the browser returned. `state` must match the value this app generated.
 */
export function parseAppSignInCallback(query: string, expectedState: string): string {
  const params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
  if (params.getAll('state').length !== 1 || params.get('state') !== expectedState) {
    throw new CloudAuthError(
      'sign_in_state_mismatch',
      'This sign-in did not come from this app. Try again.',
      0,
    );
  }
  const error = params.get('error');
  if (error) {
    if (error === 'access_denied') {
      throw new CloudAuthError('access_denied', 'Sign-in was canceled in the browser.', 0);
    }
    throw new CloudAuthError(
      'browser_sign_in_failed',
      params.get('error_description')?.trim() || 'Could not finish signing in. Try again.',
      0,
    );
  }
  const code = params.get('code')?.trim();
  if (!code) {
    throw new CloudAuthError('browser_sign_in_failed', 'Could not finish signing in. Try again.', 0);
  }
  return code;
}

type TokenResponse = {
  access_token?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
  device_id?: unknown;
  account?: unknown;
};

function tokenError(status: number, body: unknown): CloudAuthError {
  const error = oauthErrorCode(body);
  if (status === 0) {
    return new CloudAuthError('network_error', 'Could not reach the server. Check your connection and try again.', 0);
  }
  if (status === 429 || error === 'rate_limited') {
    const wait = (body as { retryAfterSeconds?: unknown } | null)?.retryAfterSeconds;
    const retryAfterSeconds = typeof wait === 'number' && Number.isFinite(wait) && wait > 0 ? Math.ceil(wait) : undefined;
    const limited = new CloudAuthError('rate_limited', '', status, retryAfterSeconds);
    return new CloudAuthError('rate_limited', rateLimitedMessage(limited), status, retryAfterSeconds);
  }
  if (error === 'invalid_grant') {
    return new CloudAuthError(
      'sign_in_code_invalid',
      'That code expired or was already used. Log in again.',
      status,
    );
  }
  if (status >= 500) {
    return new CloudAuthError('server_error', 'The server hit an unexpected error. Please try again.', status);
  }
  return new CloudAuthError(
    'browser_sign_in_failed',
    oauthErrorMessage(body) ?? 'Could not finish signing in. Try again.',
    status,
  );
}

async function postForm(fetchImpl: FetchLike, url: string, form: Record<string, string>) {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
    });
  } catch {
    return { status: 0, body: null };
  }
  return { status: response.status, body: await readJson(response) };
}

function deviceFields(device: CloudDeviceRegistration | null | undefined): Record<string, string> {
  if (!device) return {};
  return {
    device_public_key: device.publicKey,
    device_key_algorithm: device.keyAlgorithm,
    device_name: device.displayName,
    device_platform: device.platform,
    device_os_version: device.osVersion,
    device_app_version: device.appVersion,
  };
}

function tokenResult(
  body: TokenResponse,
  refreshBase: Omit<AppSignInRefresh, 'refreshToken'>,
  now: number,
): { session: CloudAuthResult['session']; refresh: AppSignInRefresh } | null {
  const { access_token: token, expires_in: expiresIn, refresh_token: refreshToken, device_id: deviceId } = body;
  if (typeof token !== 'string' || !token || typeof refreshToken !== 'string' || !refreshToken) return null;
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) return null;
  return {
    session: {
      token,
      expiresAt: new Date(now + expiresIn * 1000).toISOString(),
      ...(typeof deviceId === 'string' && deviceId ? { deviceId } : {}),
    },
    refresh: { ...refreshBase, refreshToken },
  };
}

export async function exchangeAppAuthorizationCode({
  baseUrl,
  fetchImpl,
  clientId,
  code,
  redirectUri,
  codeVerifier,
  device,
  now = Date.now,
}: {
  baseUrl: string;
  fetchImpl: FetchLike;
  clientId: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  device?: CloudDeviceRegistration | null;
  now?: () => number;
}): Promise<AppSignInResult> {
  const tokenEndpoint = appTokenEndpoint(baseUrl);
  const { status, body } = await postForm(fetchImpl, tokenEndpoint, {
    grant_type: 'authorization_code',
    client_id: clientId,
    code: code.trim(),
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
    ...deviceFields(device),
  });
  if (status < 200 || status >= 300) throw tokenError(status, body);
  const parsed = (body ?? {}) as TokenResponse;
  const result = tokenResult(parsed, { clientId, tokenEndpoint }, now());
  const account = parsed.account as CloudAccount | undefined;
  if (!result || !account || typeof account.accountId !== 'string' || !account.accountId) {
    throw new CloudAuthError('browser_sign_in_failed', 'Could not finish signing in. Try again.', status);
  }
  return { account, session: result.session, refresh: result.refresh };
}

/**
 * Refresh for runtimes without the native session store (browser previews
 * and tests). The desktop app refreshes in the native shell under a lock.
 */
export async function refreshAppSession(
  session: StoredSession,
  fetchImpl: FetchLike,
  now: () => number = Date.now,
): Promise<StoredSession> {
  const { refreshToken, clientId, tokenEndpoint } = session;
  if (!refreshToken || !clientId || !tokenEndpoint) throw new Error('not_refreshable');
  const { status, body } = await postForm(fetchImpl, tokenEndpoint, {
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken,
  });
  if (status === 0) throw new Error('network_error');
  if (status < 200 || status >= 300) {
    throw new Error(oauthErrorCode(body) === 'invalid_grant' ? 'invalid_grant' : 'refresh_failed');
  }
  const result = tokenResult((body ?? {}), { clientId, tokenEndpoint }, now());
  if (!result) throw new Error('refresh_failed');
  return { ...session, token: result.session.token, expiresAt: result.session.expiresAt, refreshToken: result.refresh.refreshToken };
}

/**
 * Ends a browser sign-in on the server (RFC 7009). Returns false for
 * sessions that did not come from browser sign-in. Best effort: a failed
 * request still lets the caller sign out locally.
 */
export async function revokeAppSignIn(session: StoredSession, fetchImpl: FetchLike): Promise<boolean> {
  const { refreshToken, clientId, tokenEndpoint } = session;
  if (!refreshToken || !clientId || !tokenEndpoint?.endsWith(APP_TOKEN_PATH)) return false;
  const revokeEndpoint = `${tokenEndpoint.slice(0, -APP_TOKEN_PATH.length)}${APP_REVOKE_PATH}`;
  await postForm(fetchImpl, revokeEndpoint, { client_id: clientId, token: refreshToken });
  return true;
}
