import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  appSignInClientId,
  appSignInHost,
  buildAppAuthorizeUrl,
  exchangeAppAuthorizationCode,
  parseAppSignInCallback,
  probeBrowserSignIn,
  refreshAppSession,
  revokeAppSignIn,
} from '../src/features/cloud/appSignIn/appSignInClient';
import {
  BrowserSignInAttempt,
  isBrowserSignInCancelled,
  type BrowserSignInDriver,
} from '../src/features/cloud/appSignIn/browserSignIn';
import { createPkcePair, createSignInState, s256CodeChallenge } from '../src/features/cloud/appSignIn/pkce';
import { CloudAuthError } from '../src/features/cloud/cloudAuthError';
import type { CloudDeviceRegistration } from '../src/features/cloud/deviceIdentity';
import {
  __setSessionBackendForTests,
  CLOUD_SESSION_SIGNED_OUT_EVENT,
  loadSession,
  type SessionStorageBackend,
  type StoredSession,
} from '../src/features/cloud/session';
import { completeCloudAuthResult } from '../src/features/cloud/useCloudSession';

const BASE_URL = 'https://app.example.test';
const ACCOUNT = { accountId: 'acct_synthetic_a', email: 'a@example.test', displayName: 'Synthetic A' };
const DEVICE: CloudDeviceRegistration = {
  displayName: 'Test Mac', platform: 'macos', osVersion: '15.0', appVersion: '0.0.0-test',
  approximateLocation: '', publicKey: 'synthetic-public-key', keyAlgorithm: 'p256',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === null ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type Recorded = { url: string; init?: RequestInit };

function recordingFetch(respond: (request: Recorded) => Response | Promise<Response>) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = { url: String(input), init };
    calls.push(request);
    return respond(request);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function formOf(request: Recorded): URLSearchParams {
  return new URLSearchParams(String(request.init?.body ?? ''));
}

const TOKEN_BODY = {
  access_token: 'kordi_cs_synthetic',
  token_type: 'Bearer',
  expires_in: 3600,
  refresh_token: 'kordi_rt_synthetic',
  refresh_token_expires_in: 2592000,
  device_id: 'dev_synthetic',
  sign_in_id: 'asi_synthetic',
  account: ACCOUNT,
};

test('PKCE verifiers are long, URL safe and hash to their S256 challenge', async () => {
  // RFC 7636, appendix B.
  assert.equal(
    await s256CodeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  );
  const first = await createPkcePair();
  const second = await createPkcePair();
  assert.match(first.verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.equal(first.challenge, await s256CodeChallenge(first.verifier));
  assert.notEqual(first.verifier, second.verifier);
  const state = createSignInState();
  assert.match(state, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(state, createSignInState());
});

test('each edition signs in with its own registered client', () => {
  assert.equal(appSignInClientId('kordi', {}), 'kordi-desktop');
  assert.equal(appSignInClientId('kordi-beta', {}), 'kordi-desktop-beta');
  assert.equal(appSignInClientId('kordi-staging', {}), 'kordi-desktop-staging');
  assert.equal(appSignInClientId(undefined, {}), 'kordi-desktop');
  assert.equal(appSignInClientId('kordi', { VITE_KORDI_APP_CLIENT_ID: 'kordi-desktop-beta' }), 'kordi-desktop-beta');
  assert.equal(appSignInHost('https://app.example.test/'), 'app.example.test');
  assert.equal(appSignInHost('http://127.0.0.1:17301'), '127.0.0.1:17301');
});

test('the authorize URL carries PKCE, state and the sign-up hint', () => {
  const login = new URL(buildAppAuthorizeUrl({
    baseUrl: `${BASE_URL}/`, clientId: 'kordi-desktop', redirectUri: 'http://127.0.0.1:4321/auth/callback',
    codeChallenge: 'challenge', state: 'state-1', intent: 'login',
  }));
  assert.equal(`${login.origin}${login.pathname}`, `${BASE_URL}/v1/cloud/auth/app/authorize`);
  assert.deepEqual(Object.fromEntries(login.searchParams), {
    response_type: 'code',
    client_id: 'kordi-desktop',
    redirect_uri: 'http://127.0.0.1:4321/auth/callback',
    code_challenge: 'challenge',
    code_challenge_method: 'S256',
    state: 'state-1',
  });
  const signup = new URL(buildAppAuthorizeUrl({
    baseUrl: BASE_URL, clientId: 'kordi-desktop', redirectUri: 'http://127.0.0.1:4321/auth/callback',
    codeChallenge: 'challenge', state: 'state-1', intent: 'signup',
  }));
  assert.equal(signup.searchParams.get('prompt'), 'create');
});

test('the callback must carry this app\'s state', () => {
  assert.equal(parseAppSignInCallback('code=kac_1&state=s1', 's1'), 'kac_1');
  assert.equal(parseAppSignInCallback('?code=kac_1&state=s1', 's1'), 'kac_1');
  const expectCode = (query: string, code: string) => assert.throws(
    () => parseAppSignInCallback(query, 's1'),
    (caught: unknown) => caught instanceof CloudAuthError && caught.code === code,
  );
  expectCode('code=kac_1&state=other', 'sign_in_state_mismatch');
  expectCode('code=kac_1', 'sign_in_state_mismatch');
  expectCode('code=kac_1&state=s1&state=s1', 'sign_in_state_mismatch');
  expectCode('error=access_denied&state=s1', 'access_denied');
  expectCode('error=server_error&error_description=Try%20later&state=s1', 'browser_sign_in_failed');
  expectCode('state=s1', 'browser_sign_in_failed');
  assert.throws(
    () => parseAppSignInCallback('error=server_error&error_description=Try%20later&state=s1', 's1'),
    /Try later/,
  );
});

test('browser sign-in is offered only by servers that know this client', async () => {
  const probe = async (respond: () => Response | Promise<Response>) => {
    const { calls, fetchImpl } = recordingFetch(respond);
    const result = await probeBrowserSignIn({ baseUrl: BASE_URL, clientId: 'kordi-desktop', fetchImpl });
    assert.equal(calls[0]?.url, `${BASE_URL}/v1/cloud/auth/app/authorize?client_id=kordi-desktop`);
    return result;
  };
  assert.equal(await probe(() => jsonResponse(400, { error: 'invalid_redirect_uri' })), 'available');
  assert.equal(await probe(() => jsonResponse(400, { error: 'invalid_client' })), 'unavailable');
  assert.equal(await probe(() => jsonResponse(404, { errorCode: 'not_found' })), 'unavailable');
  assert.equal(await probe(() => new Response('<html></html>', { status: 404 })), 'unavailable');
  assert.equal(await probe(() => jsonResponse(503, null)), 'unknown');
  assert.equal(await probe(() => { throw new TypeError('offline'); }), 'unknown');
});

test('a code exchange sends the verifier and device and returns a refreshable session', async () => {
  const { calls, fetchImpl } = recordingFetch(() => jsonResponse(200, TOKEN_BODY));
  const result = await exchangeAppAuthorizationCode({
    baseUrl: BASE_URL, fetchImpl, clientId: 'kordi-desktop', code: ' kac_1 ',
    redirectUri: 'http://127.0.0.1:4321/auth/callback', codeVerifier: 'verifier', device: DEVICE,
    now: () => Date.parse('2026-01-01T00:00:00Z'),
  });
  assert.equal(calls[0]?.url, `${BASE_URL}/v1/cloud/auth/app/token`);
  assert.equal(new Headers(calls[0]?.init?.headers).get('content-type'), 'application/x-www-form-urlencoded');
  assert.deepEqual(Object.fromEntries(formOf(calls[0]!)), {
    grant_type: 'authorization_code',
    client_id: 'kordi-desktop',
    code: 'kac_1',
    redirect_uri: 'http://127.0.0.1:4321/auth/callback',
    code_verifier: 'verifier',
    device_public_key: 'synthetic-public-key',
    device_key_algorithm: 'p256',
    device_name: 'Test Mac',
    device_platform: 'macos',
    device_os_version: '15.0',
    device_app_version: '0.0.0-test',
  });
  assert.deepEqual(result, {
    account: ACCOUNT,
    session: { token: 'kordi_cs_synthetic', expiresAt: '2026-01-01T01:00:00.000Z', deviceId: 'dev_synthetic' },
    refresh: {
      refreshToken: 'kordi_rt_synthetic',
      clientId: 'kordi-desktop',
      tokenEndpoint: `${BASE_URL}/v1/cloud/auth/app/token`,
    },
  });
});

test('code exchange errors use the sign-in error style', async () => {
  const exchange = (respond: () => Response) => exchangeAppAuthorizationCode({
    baseUrl: BASE_URL, fetchImpl: recordingFetch(respond).fetchImpl, clientId: 'kordi-desktop',
    code: 'kac_1', redirectUri: 'http://127.0.0.1:4321/auth/callback', codeVerifier: 'verifier',
  });
  const expectCode = async (respond: () => Response, code: string) => assert.rejects(
    () => exchange(respond),
    (caught: unknown) => caught instanceof CloudAuthError && caught.code === code,
  );
  await expectCode(() => jsonResponse(400, { error: 'invalid_grant', message: 'The code expired.' }), 'sign_in_code_invalid');
  await expectCode(() => jsonResponse(429, { error: 'rate_limited' }), 'rate_limited');
  await expectCode(() => jsonResponse(500, null), 'server_error');
  await expectCode(() => { throw new TypeError('offline'); }, 'network_error');
  await expectCode(() => jsonResponse(200, { ...TOKEN_BODY, account: undefined }), 'browser_sign_in_failed');
  await expectCode(() => jsonResponse(200, { ...TOKEN_BODY, refresh_token: '' }), 'browser_sign_in_failed');
});

const BROWSER_SESSION: StoredSession = {
  token: 'kordi_cs_synthetic',
  accountId: ACCOUNT.accountId,
  expiresAt: '2026-01-01T01:00:00.000Z',
  refreshToken: 'kordi_rt_synthetic',
  clientId: 'kordi-desktop',
  tokenEndpoint: `${BASE_URL}/v1/cloud/auth/app/token`,
};

test('sign-out revokes a browser sign-in and leaves older sessions to logout', async () => {
  const { calls, fetchImpl } = recordingFetch(() => jsonResponse(200, {}));
  assert.equal(await revokeAppSignIn(BROWSER_SESSION, fetchImpl), true);
  assert.equal(calls[0]?.url, `${BASE_URL}/v1/cloud/auth/app/revoke`);
  assert.deepEqual(Object.fromEntries(formOf(calls[0]!)), { client_id: 'kordi-desktop', token: 'kordi_rt_synthetic' });
  const passwordSession: StoredSession = { token: 'kordi_s_synthetic', accountId: ACCOUNT.accountId, expiresAt: '2099-01-01T00:00:00Z' };
  assert.equal(await revokeAppSignIn(passwordSession, fetchImpl), false);
  assert.equal(calls.length, 1);
});

test('refreshing rotates the refresh token and reports a refused grant', async () => {
  const { calls, fetchImpl } = recordingFetch(() => jsonResponse(200, {
    access_token: 'kordi_cs_next', expires_in: 3600, refresh_token: 'kordi_rt_next',
  }));
  const next = await refreshAppSession(BROWSER_SESSION, fetchImpl, () => Date.parse('2026-01-01T00:58:00Z'));
  assert.deepEqual(Object.fromEntries(formOf(calls[0]!)), {
    grant_type: 'refresh_token', client_id: 'kordi-desktop', refresh_token: 'kordi_rt_synthetic',
  });
  assert.equal(next.token, 'kordi_cs_next');
  assert.equal(next.refreshToken, 'kordi_rt_next');
  assert.equal(next.expiresAt, '2026-01-01T01:58:00.000Z');
  assert.equal(next.accountId, ACCOUNT.accountId);
  await assert.rejects(
    () => refreshAppSession(BROWSER_SESSION, recordingFetch(() => jsonResponse(400, { error: 'invalid_grant' })).fetchImpl),
    /invalid_grant/,
  );
});

function fakeDriver(overrides: Partial<BrowserSignInDriver> = {}) {
  const events: string[] = [];
  let expectedState = '';
  let resolveWait!: (query: string) => void;
  let rejectWait!: (error: Error) => void;
  const driver: BrowserSignInDriver = {
    prepare: async (state) => {
      expectedState = state;
      events.push('prepare');
      return { requestId: 'req_1', redirectUrl: 'http://127.0.0.1:4321/auth/callback' };
    },
    wait: () => new Promise<string>((resolve, reject) => { resolveWait = resolve; rejectWait = reject; }),
    cancel: async () => {
      events.push('cancel');
      rejectWait?.(new Error('Browser sign-in was canceled.'));
    },
    openUrl: async (url) => { events.push(`open ${url}`); },
    copyText: async (text) => { events.push(`copy ${text}`); },
    ...overrides,
  };
  return {
    driver,
    events,
    state: () => expectedState,
    returnFromBrowser: (query: string) => resolveWait(query),
    failWait: (error: Error) => rejectWait(error),
  };
}

function attemptConfig(driver: BrowserSignInDriver, respond: (request: Recorded) => Response = () => jsonResponse(200, TOKEN_BODY)) {
  const recorded = recordingFetch(respond);
  return {
    recorded,
    config: {
      baseUrl: BASE_URL, clientId: 'kordi-desktop', fetchImpl: recorded.fetchImpl, driver,
      deviceRegistration: async () => DEVICE,
    },
  };
}

test('a browser attempt binds its listener to the URL state and exchanges the returned code', async () => {
  const fake = fakeDriver();
  const { config, recorded } = attemptConfig(fake.driver);
  const attempt = await BrowserSignInAttempt.start(config, 'signup');
  const url = new URL(attempt.authorizeUrl);
  assert.equal(url.searchParams.get('state'), fake.state());
  assert.equal(url.searchParams.get('prompt'), 'create');
  await attempt.openBrowser();
  assert.equal(fake.events.at(-1), `open ${attempt.authorizeUrl}`);
  const pending = attempt.waitForBrowser();
  fake.returnFromBrowser(`code=kac_1&state=${fake.state()}`);
  const result = await pending;
  assert.equal(result.account.accountId, ACCOUNT.accountId);
  const verifier = formOf(recorded.calls[0]!).get('code_verifier')!;
  assert.equal(await s256CodeChallenge(verifier), url.searchParams.get('code_challenge'));
  assert.ok(fake.events.includes('cancel'), 'the listener stops after the exchange');
});

test('a browser attempt refuses a callback for another state and maps browser errors', async () => {
  const mismatch = fakeDriver();
  const attempt = await BrowserSignInAttempt.start(attemptConfig(mismatch.driver).config, 'login');
  const pending = attempt.waitForBrowser();
  mismatch.returnFromBrowser('code=kac_1&state=forged');
  await assert.rejects(pending, (caught: unknown) => caught instanceof CloudAuthError && caught.code === 'sign_in_state_mismatch');

  const denied = fakeDriver();
  const deniedAttempt = await BrowserSignInAttempt.start(attemptConfig(denied.driver).config, 'login');
  const deniedResult = deniedAttempt.waitForBrowser();
  denied.returnFromBrowser(`error=access_denied&state=${denied.state()}`);
  await assert.rejects(deniedResult, (caught: unknown) => caught instanceof CloudAuthError && caught.code === 'access_denied');

  const slow = fakeDriver();
  const slowAttempt = await BrowserSignInAttempt.start(attemptConfig(slow.driver).config, 'login');
  const slowResult = slowAttempt.waitForBrowser();
  slow.failWait(new Error('Browser sign-in timed out. Try again.'));
  await assert.rejects(slowResult, (caught: unknown) => caught instanceof CloudAuthError && caught.code === 'browser_sign_in_timed_out');
});

test('canceling stops the listener and settles the wait as canceled', async () => {
  const fake = fakeDriver();
  const attempt = await BrowserSignInAttempt.start(attemptConfig(fake.driver).config, 'login');
  const pending = attempt.waitForBrowser();
  attempt.cancel();
  await assert.rejects(pending, (caught: unknown) => isBrowserSignInCancelled(caught));
  assert.ok(fake.events.includes('cancel'));
  await assert.rejects(attempt.exchangeCode('kac_1'), (caught: unknown) => isBrowserSignInCancelled(caught));
});

test('a pasted code finishes the attempt once and a failed code can be retried', async () => {
  const fake = fakeDriver();
  let exchanges = 0;
  const { config } = attemptConfig(fake.driver, () => {
    exchanges += 1;
    return exchanges === 1 ? jsonResponse(400, { error: 'invalid_grant' }) : jsonResponse(200, TOKEN_BODY);
  });
  const attempt = await BrowserSignInAttempt.start(config, 'login');
  const waiting = attempt.waitForBrowser();
  await assert.rejects(attempt.exchangeCode('kac_expired'), (caught: unknown) => caught instanceof CloudAuthError && caught.code === 'sign_in_code_invalid');
  const [first, second] = await Promise.all([attempt.exchangeCode('kac_2'), attempt.exchangeCode('kac_2')]);
  assert.equal(first, second);
  assert.equal(exchanges, 2);
  // The listener was stopped; the wait resolves with the same sign-in.
  assert.equal(await waiting, first);
});

function memoryBackend(session: StoredSession | null, refresh?: SessionStorageBackend['refresh']) {
  let stored = session;
  const backend: SessionStorageBackend = {
    load: async () => stored,
    save: async (next) => { stored = next; },
    clear: async () => { stored = null; },
    ...(refresh ? { refresh } : {}),
  };
  return { backend, stored: () => stored };
}

test('loading a session refreshes a browser sign-in once shortly before expiry', async () => {
  const expiringSoon = { ...BROWSER_SESSION, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  let refreshes = 0;
  const { backend } = memoryBackend(expiringSoon, async (session) => {
    refreshes += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { ...session, token: 'kordi_cs_next', expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
  });
  __setSessionBackendForTests(backend);
  try {
    const [a, b] = await Promise.all([loadSession(), loadSession()]);
    assert.equal(refreshes, 1);
    assert.equal(a?.token, 'kordi_cs_next');
    assert.equal(b?.token, 'kordi_cs_next');
    assert.equal((await loadSession())?.token, 'kordi_cs_next');
    assert.equal(refreshes, 1);
  } finally {
    __setSessionBackendForTests(null);
  }
});

test('sessions without a refresh token or far from expiry are not refreshed', async () => {
  let refreshes = 0;
  const refresh = async (session: StoredSession) => { refreshes += 1; return session; };
  const fresh = { ...BROWSER_SESSION, expiresAt: new Date(Date.now() + 3_000_000).toISOString() };
  __setSessionBackendForTests(memoryBackend(fresh, refresh).backend);
  try {
    assert.equal((await loadSession())?.token, fresh.token);
    __setSessionBackendForTests(memoryBackend({ token: 'kordi_s_synthetic', accountId: 'acct', expiresAt: '2000-01-01T00:00:00Z' }, refresh).backend);
    assert.equal((await loadSession())?.token, 'kordi_s_synthetic');
    assert.equal(refreshes, 0);
  } finally {
    __setSessionBackendForTests(null);
  }
});

test('a refused refresh signs out; a network failure keeps the session for a retry', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const target = new EventTarget();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: target });
  let signedOut = 0;
  target.addEventListener(CLOUD_SESSION_SIGNED_OUT_EVENT, () => { signedOut += 1; });
  const expired = { ...BROWSER_SESSION, expiresAt: new Date(Date.now() - 1_000).toISOString() };
  try {
    const offline = memoryBackend(expired, async () => { throw new Error('network_error'); });
    __setSessionBackendForTests(offline.backend);
    assert.equal((await loadSession())?.token, expired.token);
    assert.equal(signedOut, 0);

    const refused = memoryBackend(expired, async () => { throw new Error('invalid_grant'); });
    __setSessionBackendForTests(refused.backend);
    assert.equal(await loadSession(), null);
    assert.equal(refused.stored(), null);
    assert.equal(signedOut, 1);
  } finally {
    __setSessionBackendForTests(null);
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('a browser sign-in for another account reloads into fresh account storage', async () => {
  const saved: StoredSession[] = [];
  let published = 0;
  let reloads = 0;
  const result = {
    account: { ...ACCOUNT, accountId: 'acct_synthetic_b' },
    session: { token: 'kordi_cs_b', expiresAt: '2026-01-01T01:00:00.000Z', deviceId: 'dev_b' },
  } as Parameters<typeof completeCloudAuthResult>[0]['result'];
  const completed = await completeCloudAuthResult({
    result,
    currentAccountId: ACCOUNT.accountId,
    saveSession: async (session) => { saved.push(session); },
    activateAccountStorage: async (accountId) => ({ accountId, storageRoot: `/synthetic/${accountId}`, requiresReload: true }),
    setAuthenticated: () => { published += 1; },
    reloadWindow: () => { reloads += 1; },
  });
  assert.equal(completed, false);
  assert.equal(published, 0, 'the previous account\'s in-memory state is never shown with the new account');
  assert.equal(reloads, 1);
  assert.equal(saved[0]?.accountId, 'acct_synthetic_b');
});
