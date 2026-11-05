import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { buildAppAuthorizeUrl } from '../src/features/cloud/appSignIn/appSignInClient';
import { BrowserSignInAttempt, type BrowserSignInDriver } from '../src/features/cloud/appSignIn/browserSignIn';
import { CloudAuthClient } from '../src/features/cloud/authClient';
import { CloudAuthError } from '../src/features/cloud/cloudAuthError';
import type { CloudDeviceRegistration } from '../src/features/cloud/deviceIdentity';
import {
  admitManagedSignIn,
  checkManagedMembership,
  signOutIfManagedPolicyRefuses,
} from '../src/features/cloud/managedPolicy/managedSignInAdmission';
import {
  __setManagedSignInPolicyForTests,
  accountSatisfiesPolicy,
  anyMethodAllowed,
  isMethodAllowed,
  MANAGED_SIGNED_OUT_MESSAGE,
  managedSignedOutNotice,
  normalizeManagedSignInPolicy,
  NO_MANAGED_POLICY,
  organizationHint,
  type ManagedSignInPolicy,
} from '../src/features/cloud/managedPolicy/managedSignInPolicy';
import {
  __setSessionBackendForTests,
  CLOUD_SESSION_SIGNED_OUT_EVENT,
  loadSession,
  type SessionStorageBackend,
  type StoredSession,
} from '../src/features/cloud/session';
import { completeCloudAuthResult } from '../src/features/cloud/useCloudSession';
import { CloudLoginPage } from '../src/kordi-app/cloud/CloudLoginPage';

const BASE_URL = 'https://app.example.test';
const ORG_POLICY: ManagedSignInPolicy = { allowedSignInMethods: null, allowedOrganizations: ['example-university', 'org_test_b'] };
const ACCOUNT = { accountId: 'acct_synthetic', email: 'a@example.test', displayName: 'Synthetic' };
const DEVICE: CloudDeviceRegistration = {
  displayName: 'Test Mac', platform: 'macos', osVersion: '15.0', appVersion: '0.0.0-test',
  approximateLocation: '', publicKey: 'synthetic-public-key', keyAlgorithm: 'p256',
};

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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function organizations(entries: { organizations?: unknown[]; configured?: unknown[] }) {
  return { organizations: entries.organizations ?? [], configured: entries.configured ?? [] };
}

afterEach(() => {
  __setManagedSignInPolicyForTests(null);
  __setSessionBackendForTests(null);
});

test('policy values follow the shared fail-closed rules', () => {
  assert.deepEqual(normalizeManagedSignInPolicy(null), NO_MANAGED_POLICY);
  assert.deepEqual(normalizeManagedSignInPolicy({}), NO_MANAGED_POLICY);
  assert.deepEqual(
    normalizeManagedSignInPolicy({ allowedSignInMethods: [' Google ', 'EMAIL', 'sso', 'google'], allowedOrganizations: [' example-university ', '', 'org_test_b'] }),
    { allowedSignInMethods: ['google', 'email'], allowedOrganizations: ['example-university', 'org_test_b'] },
  );
  // Not an array of strings, or no valid entry: the key allows nothing.
  assert.deepEqual(normalizeManagedSignInPolicy({ allowedSignInMethods: ['google', 1], allowedOrganizations: 'example-university' }), {
    allowedSignInMethods: [], allowedOrganizations: [],
  });
  assert.deepEqual(normalizeManagedSignInPolicy({ allowedSignInMethods: ['sso'] }).allowedSignInMethods, []);
  // Organization ids compare exactly.
  assert.deepEqual(normalizeManagedSignInPolicy({ allowedOrganizations: ['Example-University'] }).allowedOrganizations, ['Example-University']);
});

test('method and hint helpers', () => {
  const googleOnly: ManagedSignInPolicy = { allowedSignInMethods: ['google'], allowedOrganizations: ['example-university'] };
  assert.equal(isMethodAllowed(googleOnly, 'google'), true);
  assert.equal(isMethodAllowed(googleOnly, 'email'), false);
  assert.equal(isMethodAllowed(NO_MANAGED_POLICY, 'github'), true);
  assert.equal(anyMethodAllowed({ allowedSignInMethods: [], allowedOrganizations: null }), false);
  assert.equal(anyMethodAllowed(NO_MANAGED_POLICY), true);
  assert.equal(organizationHint(googleOnly), 'example-university');
  assert.equal(organizationHint(NO_MANAGED_POLICY), undefined);
});

test('the membership check accepts allowed memberships and admitted configured organizations only', () => {
  assert.equal(accountSatisfiesPolicy(organizations({}), NO_MANAGED_POLICY), true);
  assert.equal(accountSatisfiesPolicy(organizations({ organizations: [{ organizationId: 'org_test_b' }] }), ORG_POLICY), true);
  assert.equal(accountSatisfiesPolicy(organizations({ organizations: [{ organizationId: 'org_other' }] }), ORG_POLICY), false);
  for (const admission of ['member', 'reverify']) {
    assert.equal(accountSatisfiesPolicy(organizations({ configured: [{ id: 'example-university', organizationId: 'org_test_a', admission }] }), ORG_POLICY), true);
    assert.equal(accountSatisfiesPolicy(organizations({ configured: [{ id: 'other-config', organizationId: 'org_test_b', admission }] }), ORG_POLICY), true);
  }
  for (const admission of ['join', 'pending', 'lapsed', 'not_open', 'rejected']) {
    assert.equal(accountSatisfiesPolicy(organizations({ configured: [{ id: 'example-university', organizationId: 'org_test_a', admission }] }), ORG_POLICY), false);
  }
  assert.equal(accountSatisfiesPolicy({ allowedOrganizations: [] }, { ...ORG_POLICY, allowedOrganizations: [] }), false);
  assert.equal(accountSatisfiesPolicy(null, ORG_POLICY), false);
});

test('checkManagedMembership sends the bearer and separates refusal from failure', async () => {
  const allowed = recordingFetch(() => jsonResponse(200, organizations({ organizations: [{ organizationId: 'org_test_b' }] })));
  assert.equal(await checkManagedMembership('kordi_cs_a', { policy: ORG_POLICY, baseUrl: BASE_URL, fetchImpl: allowed.fetchImpl }), 'allowed');
  assert.equal(allowed.calls[0]?.url, `${BASE_URL}/v1/cloud/account/organizations`);
  assert.equal(new Headers(allowed.calls[0]?.init?.headers).get('authorization'), 'Bearer kordi_cs_a');

  const refused = recordingFetch(() => jsonResponse(200, organizations({})));
  assert.equal(await checkManagedMembership('kordi_cs_a', { policy: ORG_POLICY, baseUrl: BASE_URL, fetchImpl: refused.fetchImpl }), 'refused');

  for (const respond of [
    () => jsonResponse(503, { errorCode: 'server_error' }),
    () => jsonResponse(200, { configured: [] }),
    () => new Response('not json', { status: 200 }),
    () => { throw new TypeError('offline'); },
  ]) {
    const failed = recordingFetch(respond);
    assert.equal(await checkManagedMembership('kordi_cs_a', { policy: ORG_POLICY, baseUrl: BASE_URL, fetchImpl: failed.fetchImpl }), 'failed');
  }

  const none = recordingFetch(() => jsonResponse(200, organizations({})));
  assert.equal(await checkManagedMembership('kordi_cs_a', { policy: NO_MANAGED_POLICY, baseUrl: BASE_URL, fetchImpl: none.fetchImpl }), 'allowed');
  assert.equal(none.calls.length, 0, 'no policy, no request');
});

test('a refused browser sign-in is revoked and never stored', async () => {
  const { calls, fetchImpl } = recordingFetch((request) => (
    request.url.endsWith('/organizations') ? jsonResponse(200, organizations({})) : new Response(null, { status: 200 })
  ));
  const result = {
    account: ACCOUNT,
    session: { token: 'kordi_cs_new', expiresAt: '2026-01-01T01:00:00.000Z' },
    refresh: { refreshToken: 'kordi_rt_new', clientId: 'kordi-desktop', tokenEndpoint: `${BASE_URL}/v1/cloud/auth/app/token` },
  };
  await assert.rejects(
    admitManagedSignIn(result, { policy: ORG_POLICY, baseUrl: BASE_URL, fetchImpl }),
    (caught: unknown) => caught instanceof CloudAuthError && caught.code === 'organization_not_allowed'
      && caught.message === 'This device only allows accounts from your organization.',
  );
  const revoke = calls.find((call) => call.url === `${BASE_URL}/v1/cloud/auth/app/revoke`);
  assert.ok(revoke, 'the new browser sign-in is revoked');
  assert.equal(new URLSearchParams(String(revoke.init?.body)).get('token'), 'kordi_rt_new');
});

test('a failed check fails a password sign-in and logs the new session out', async () => {
  const { calls, fetchImpl } = recordingFetch((request) => (
    request.url.endsWith('/organizations') ? jsonResponse(502, {}) : new Response(null, { status: 204 })
  ));
  await assert.rejects(
    admitManagedSignIn({ account: ACCOUNT, session: { token: 'kordi_s_new', expiresAt: '2026-01-01T01:00:00.000Z' } }, { policy: ORG_POLICY, baseUrl: BASE_URL, fetchImpl }),
    (caught: unknown) => caught instanceof CloudAuthError && caught.code === 'organization_check_failed'
      && caught.message === 'Could not check your organization. Try again.',
  );
  const logout = calls.find((call) => call.url === `${BASE_URL}/v1/cloud/auth/logout`);
  assert.equal(new Headers(logout?.init?.headers).get('authorization'), 'Bearer kordi_s_new');
});

async function withGlobalFetch<T>(fetchImpl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const previous = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = previous;
  }
}

test('sign-in completion checks the account before storing the session', async () => {
  __setManagedSignInPolicyForTests(ORG_POLICY);
  const saved: StoredSession[] = [];
  let published = 0;
  const { fetchImpl } = recordingFetch((request) => (
    request.url.endsWith('/organizations') ? jsonResponse(200, organizations({ organizations: [{ organizationId: 'org_other' }] })) : new Response(null, { status: 204 })
  ));
  await withGlobalFetch(fetchImpl, () => assert.rejects(completeCloudAuthResult({
    result: { account: ACCOUNT, session: { token: 'kordi_s_new', expiresAt: '2026-01-01T01:00:00.000Z' } },
    currentAccountId: null,
    saveSession: async (session) => { saved.push(session); },
    activateAccountStorage: async (accountId) => ({ accountId, storageRoot: null, requiresReload: false }),
    setAuthenticated: () => { published += 1; },
  }), (caught: unknown) => caught instanceof CloudAuthError && caught.code === 'organization_not_allowed'));
  assert.equal(saved.length, 0);
  assert.equal(published, 0);
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

async function withWindow<T>(run: (signedOut: () => number) => Promise<T>): Promise<T> {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const target = new EventTarget();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: target });
  let signedOut = 0;
  target.addEventListener(CLOUD_SESSION_SIGNED_OUT_EVENT, () => { signedOut += 1; });
  try {
    return await run(() => signedOut);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

const EXPIRED: StoredSession = {
  token: 'kordi_cs_old', accountId: ACCOUNT.accountId, expiresAt: new Date(Date.now() - 1_000).toISOString(),
  refreshToken: 'kordi_rt_old', clientId: 'kordi-desktop', tokenEndpoint: `${BASE_URL}/v1/cloud/auth/app/token`,
};
const rotate = async (session: StoredSession) => ({ ...session, token: 'kordi_cs_next', expiresAt: new Date(Date.now() + 3_600_000).toISOString() });

test('a refresh signs out locally only when the server says the account no longer qualifies', async () => {
  __setManagedSignInPolicyForTests(ORG_POLICY);
  await withWindow(async (signedOut) => {
    const offline = memoryBackend(EXPIRED, rotate);
    __setSessionBackendForTests(offline.backend);
    await withGlobalFetch((async () => { throw new TypeError('offline'); }) as typeof fetch, async () => {
      assert.equal((await loadSession())?.token, 'kordi_cs_next', 'a network error keeps the session');
    });
    assert.equal(signedOut(), 0);

    const refused = memoryBackend(EXPIRED, rotate);
    __setSessionBackendForTests(refused.backend);
    await withGlobalFetch((async () => jsonResponse(200, organizations({}))) as typeof fetch, async () => {
      assert.equal(await loadSession(), null);
    });
    assert.equal(refused.stored(), null);
    assert.equal(signedOut(), 1);
    assert.equal(managedSignedOutNotice(), MANAGED_SIGNED_OUT_MESSAGE);
  });
});

test('app start signs a restored session out on a definitive refusal only', async () => {
  __setManagedSignInPolicyForTests(ORG_POLICY);
  await withWindow(async (signedOut) => {
    const stored = memoryBackend({ ...EXPIRED, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    __setSessionBackendForTests(stored.backend);
    const failing = recordingFetch(() => jsonResponse(500, {}));
    assert.equal(await signOutIfManagedPolicyRefuses({ token: 'kordi_cs_old' }, { baseUrl: BASE_URL, fetchImpl: failing.fetchImpl }), false);
    assert.notEqual(stored.stored(), null);
    const refusing = recordingFetch(() => jsonResponse(200, organizations({ configured: [{ id: 'example-university', admission: 'lapsed' }] })));
    assert.equal(await signOutIfManagedPolicyRefuses({ token: 'kordi_cs_old' }, { baseUrl: BASE_URL, fetchImpl: refusing.fetchImpl }), true);
    assert.equal(stored.stored(), null);
    assert.equal(signedOut(), 1);
  });
});

test('browser sign-in sends the hints and refuses to start when nothing is allowed', async () => {
  const url = new URL(buildAppAuthorizeUrl({
    baseUrl: BASE_URL, clientId: 'kordi-desktop', redirectUri: 'http://127.0.0.1:1/callback', codeChallenge: 'c', state: 's',
    intent: 'login', organizationHint: 'example-university', signInMethods: ['google', 'email'],
  }));
  assert.equal(url.searchParams.get('organization_hint'), 'example-university');
  assert.equal(url.searchParams.get('sign_in_methods'), 'google,email');
  const plain = new URL(buildAppAuthorizeUrl({
    baseUrl: BASE_URL, clientId: 'kordi-desktop', redirectUri: 'http://127.0.0.1:1/callback', codeChallenge: 'c', state: 's', intent: 'login',
  }));
  assert.equal(plain.searchParams.has('organization_hint'), false);
  assert.equal(plain.searchParams.has('sign_in_methods'), false);

  let prepared = 0;
  const driver: BrowserSignInDriver = {
    prepare: async () => { prepared += 1; return { requestId: 'req', redirectUrl: 'http://127.0.0.1:1/callback' }; },
    wait: async () => '',
    cancel: async () => {},
    openUrl: async () => undefined,
  };
  const config = { baseUrl: BASE_URL, clientId: 'kordi-desktop', fetchImpl: recordingFetch(() => jsonResponse(500, {})).fetchImpl, driver };
  const attempt = await BrowserSignInAttempt.start({
    ...config, managedPolicy: async () => ({ allowedSignInMethods: ['github'], allowedOrganizations: ['org_test_b'] }),
  }, 'login');
  const authorize = new URL(attempt.authorizeUrl);
  assert.equal(authorize.searchParams.get('organization_hint'), 'org_test_b');
  assert.equal(authorize.searchParams.get('sign_in_methods'), 'github');
  attempt.cancel();
  await assert.rejects(
    BrowserSignInAttempt.start({ ...config, managedPolicy: async () => ({ allowedSignInMethods: [], allowedOrganizations: null }) }, 'login'),
    (caught: unknown) => caught instanceof CloudAuthError && caught.code === 'sign_in_method_not_allowed',
  );
  assert.equal(prepared, 1, 'a refused start opens no listener');
});

test('the in-app client refuses disallowed methods before any request and hints the organization', async () => {
  __setManagedSignInPolicyForTests({ allowedSignInMethods: ['google'], allowedOrganizations: ['example-university'] });
  const { calls, fetchImpl } = recordingFetch(() => jsonResponse(200, { authUrl: 'https://accounts.example.test/auth' }));
  const client = new CloudAuthClient({ baseUrl: BASE_URL, fetchImpl, deviceRegistration: async () => DEVICE });
  await client.startOAuth('google', 'http://127.0.0.1:1/');
  assert.equal(new URL(calls[0]!.url).searchParams.get('organizationHint'), 'example-university');
  for (const run of [
    () => client.startOAuth('github', 'http://127.0.0.1:1/'),
    () => client.login({ email: 'a@example.test', password: 'Synthetic1' }),
    () => client.requestSignupCode('a@example.test'),
  ]) {
    await assert.rejects(run(), (caught: unknown) => caught instanceof CloudAuthError && caught.code === 'sign_in_method_not_allowed');
  }
  assert.equal(calls.length, 1);
});

test('the in-app form shows only the allowed methods', () => {
  const googleOnly = renderToStaticMarkup(createElement(CloudLoginPage, {
    onSocialSignIn: async () => {}, allowedSignInMethods: ['google'],
  }));
  assert.match(googleOnly, /data-provider="google"/);
  assert.doesNotMatch(googleOnly, /data-provider="github"/);
  assert.doesNotMatch(googleOnly, /type="email"/);

  const emailOnly = renderToStaticMarkup(createElement(CloudLoginPage, {
    onSocialSignIn: async () => {}, allowedSignInMethods: ['email'],
  }));
  assert.doesNotMatch(emailOnly, /data-provider=/);
  assert.match(emailOnly, /type="email"/);
  assert.match(emailOnly, /Email and password/);

  const unrestricted = renderToStaticMarkup(createElement(CloudLoginPage, { onSocialSignIn: async () => {} }));
  assert.match(unrestricted, /data-provider="github"/);
  assert.match(unrestricted, /type="email"/);
});
