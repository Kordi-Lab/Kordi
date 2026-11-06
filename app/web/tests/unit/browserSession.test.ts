import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserSessionMarker, browserSessionAccountId, isBrowserAppRuntime } from '@web/auth/browserAppRuntime';
import { BrowserSessionBackend, browserAuthResult } from '@web/auth/browserSessionBackend';
import { withBrowserSession } from '@web/auth/browserSessionTransport';
import { cloudWebSocketUrl } from '@/features/cloud/cloudApiEnvironment';
import { buildCloudAuthError } from '@/features/cloud/cloudAuthError';
import { isCloudSessionRejected } from '@/features/cloud/cloudSessionRejection';
import type { CloudAccount } from '@/features/cloud/cloudIdentityTypes';

const origin = 'https://web.example.test';
const marker = browserSessionMarker('acct_browser');
const account = { accountId: 'acct_browser' } as CloudAccount;

test('browser target requires an explicit flag and never overrides Tauri', () => {
  const previous = (globalThis as { window?: unknown }).window;
  try {
    (globalThis as { window?: unknown }).window = {};
    assert.equal(isBrowserAppRuntime({}), false);
    assert.equal(isBrowserAppRuntime({ VITE_KORDI_WEB_APP: '1' }), true);
    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
    assert.equal(isBrowserAppRuntime({ VITE_KORDI_WEB_APP: '1' }), false);
  } finally {
    if (previous === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previous;
  }
});

test('browser API requests replace the public marker with account-bound cookie authentication', async () => {
  const requests: Request[] = [];
  const transport = withBrowserSession(async (input, init) => {
    requests.push(new Request(input, init));
    return Response.json({});
  }, origin, () => '__Host-kordi_web_csrf=synthetic-csrf');
  await transport(`${origin}/v2/chat/conversations`, {
    method: 'POST', headers: { authorization: `Bearer ${marker}`, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(requests[0].headers.get('authorization'), null);
  assert.equal(requests[0].headers.get('x-kordi-web-account'), 'acct_browser');
  assert.equal(requests[0].headers.get('x-kordi-csrf-token'), 'synthetic-csrf');
  assert.equal(requests[0].credentials, 'same-origin');
  assert.equal(requests[0].redirect, 'error');
  assert.equal(await requests[0].text(), '{}');
  await transport(new Request(`${origin}/v1/cloud/auth/me`, { headers: { authorization: `Bearer ${marker}` } }));
  assert.equal(requests[1].headers.get('x-kordi-web-account'), 'acct_browser');
  assert.equal(requests[1].headers.get('x-kordi-csrf-token'), null);
});

test('browser markers cannot be forwarded to another origin or non-API resource', async () => {
  let calls = 0;
  const transport = withBrowserSession(async () => { calls += 1; return Response.json({}); }, origin, () => '');
  for (const url of ['https://other.example.test/v1/cloud/auth/me', `${origin}/assets/image.png`]) {
    await assert.rejects(transport(url, { headers: { authorization: `Bearer ${marker}` } }), /same-origin Kordi API/);
  }
  assert.equal(calls, 0);
});

test('asset requests and native bearer credentials are not rewritten as browser markers', async () => {
  const requests: Request[] = [];
  const transport = withBrowserSession(async (input, init) => {
    requests.push(new Request(input, init)); return Response.json({});
  }, origin, () => '__Host-kordi_web_csrf=synthetic-csrf');
  await transport('https://assets.example.test/file', { credentials: 'omit' });
  await transport(`${origin}/v1/cloud/auth/me`, { headers: { authorization: 'Bearer synthetic-native-token' } });
  assert.equal(requests[0].credentials, 'omit');
  assert.equal(requests[0].headers.get('x-kordi-csrf-token'), null);
  assert.equal(requests[1].headers.get('authorization'), 'Bearer synthetic-native-token');
});

test('browser session restoration and organization switching never expose a credential', async () => {
  const requests: Request[] = [];
  const backend = new BrowserSessionBackend(withBrowserSession(async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return request.method === 'GET'
      ? Response.json({ account, csrfToken: 'synthetic-csrf', session: { deviceId: 'device_browser', organizationId: 'org_personal' } })
      : Response.json({ account_id: account.accountId, device_id: 'device_browser', organization_id: 'org_team' });
  }, origin, () => '__Host-kordi_web_csrf=synthetic-csrf'), origin);
  const session = await backend.load();
  assert.equal(session?.token, marker);
  assert.equal(session?.organizationId, 'org_personal');
  assert.equal(session?.deviceId, 'device_browser');
  assert.ok(session);
  await backend.save(session);
  const switched = await backend.switchOrganization(session, 'org_team');
  assert.equal(switched.organizationId, 'org_team');
  assert.equal(switched.token, marker);
  assert.equal(requests[1].headers.get('authorization'), null);
  await assert.rejects(backend.save({ ...session, token: 'synthetic-secret' }), /HttpOnly/);
});

test('session restoration distinguishes sign-out from an unavailable server', async () => {
  const signedOut = new BrowserSessionBackend(async () => new Response(null, { status: 401 }), origin);
  assert.equal(await signedOut.load(), null);
  const unavailable = new BrowserSessionBackend(async () => new Response(null, { status: 503 }), origin);
  await assert.rejects(unavailable.load(), /restore/);
  assert.equal(buildCloudAuthError(401, { error: 'login_required' }, 'Failed').code, 'invalid_session');
  assert.equal(isCloudSessionRejected(buildCloudAuthError(403, { error: 'browser_account_changed' }, 'Failed')), true);
});

test('browser WebSocket URLs carry only public account identity', () => {
  const url = new URL(cloudWebSocketUrl(marker, origin));
  assert.equal(url.protocol, 'wss:');
  assert.equal(url.searchParams.get('account'), account.accountId);
  assert.equal(url.searchParams.has('token'), false);
  assert.equal(browserSessionAccountId(marker), account.accountId);
  assert.equal(browserSessionAccountId('kordi-browser:%ZZ'), null);
  assert.equal(browserAuthResult({ account }).session.token, marker);
  assert.equal(new URL(cloudWebSocketUrl('synthetic-native-token', origin)).searchParams.get('token'), 'synthetic-native-token');
});
