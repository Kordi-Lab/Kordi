import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pollDeviceCode, requestDeviceCode } from '../src/features/cloud/appSignIn/appSignInClient';
import type { BrowserSignInDriver } from '../src/features/cloud/appSignIn/browserSignIn';
import { DeviceCodeAttempt } from '../src/features/cloud/appSignIn/deviceCodeSignIn';
import { CloudAuthError } from '../src/features/cloud/cloudAuthError';
import type { CloudDeviceRegistration } from '../src/features/cloud/deviceIdentity';

const BASE_URL = 'https://app.example.test';
const ACCOUNT = { accountId: 'acct_synthetic', email: 'a@example.test', displayName: 'Synthetic' };
const DEVICE: CloudDeviceRegistration = {
  displayName: 'Build Mac mini', platform: 'macos', osVersion: '26.1', appVersion: '0.0.0-test',
  approximateLocation: '', publicKey: 'synthetic-public-key', keyAlgorithm: 'p256',
};
const CODE_BODY = {
  device_code: 'kordi_dc_synthetic', user_code: 'CDFG-HJKM', verification_uri: `${BASE_URL}/device`,
  expires_in: 900, interval: 5,
};
const TOKEN_BODY = {
  access_token: 'kordi_cs_synthetic', expires_in: 3600, refresh_token: 'kordi_rt_synthetic',
  device_id: 'dev_synthetic', account: ACCOUNT,
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Answers each request with the next scripted response and records it. */
function scriptedFetch(responses: Array<[number, unknown]>) {
  const requests: Array<{ url: string; form: URLSearchParams }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), form: new URLSearchParams(String(init?.body ?? '')) });
    const next = responses.shift();
    assert.ok(next, `unexpected request to ${String(input)}`);
    return json(next[0], next[1]);
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const driver: BrowserSignInDriver = {
  prepare: async () => ({ requestId: 'unused', redirectUrl: 'http://127.0.0.1:1/auth/callback' }),
  wait: () => new Promise(() => {}),
  cancel: async () => {},
  openUrl: async () => {},
};

test('a code request sends the device and reads the prompt', async () => {
  const { fetchImpl, requests } = scriptedFetch([[200, CODE_BODY]]);
  const prompt = await requestDeviceCode({
    baseUrl: `${BASE_URL}/`, fetchImpl, clientId: 'kordi-desktop', device: DEVICE, now: () => 1_000,
  });
  assert.deepEqual(prompt, {
    deviceCode: 'kordi_dc_synthetic', userCode: 'CDFG-HJKM', verificationUri: `${BASE_URL}/device`,
    expiresAt: 901_000, intervalMs: 5_000,
  });
  assert.equal(requests[0]?.url, `${BASE_URL}/v1/cloud/auth/device/code`);
  assert.equal(requests[0]?.form.get('client_id'), 'kordi-desktop');
  assert.equal(requests[0]?.form.get('device_name'), 'Build Mac mini');
  assert.equal(requests[0]?.form.get('device_public_key'), 'synthetic-public-key');
});

test('a server without device codes answers unavailable', async () => {
  const { fetchImpl } = scriptedFetch([[404, {}]]);
  await assert.rejects(
    requestDeviceCode({ baseUrl: BASE_URL, fetchImpl, clientId: 'kordi-desktop' }),
    (error: unknown) => error instanceof CloudAuthError && error.code === 'device_code_unavailable',
  );
});

test('polls map pending, slow down, denial and expiry', async () => {
  const { fetchImpl, requests } = scriptedFetch([
    [400, { error: 'authorization_pending' }],
    [400, { error: 'slow_down', interval: 10 }],
    [400, { error: 'access_denied', error_description: 'Your organization does not allow sign-in with a code.', reason: 'organization_policy' }],
    [400, { error: 'expired_token' }],
    [200, TOKEN_BODY],
  ]);
  const poll = () => pollDeviceCode({ baseUrl: BASE_URL, fetchImpl, clientId: 'kordi-desktop', deviceCode: 'kordi_dc_synthetic' });
  assert.deepEqual(await poll(), { kind: 'pending' });
  assert.deepEqual(await poll(), { kind: 'slow_down', intervalMs: 10_000 });
  await assert.rejects(poll(), (error: unknown) =>
    error instanceof CloudAuthError && error.code === 'device_code_denied'
    && error.message === 'Your organization does not allow sign-in with a code.');
  await assert.rejects(poll(), (error: unknown) => error instanceof CloudAuthError && error.code === 'device_code_expired');
  const done = await poll();
  assert.equal(done.kind, 'signed_in');
  if (done.kind === 'signed_in') {
    assert.equal(done.result.account.accountId, ACCOUNT.accountId);
    assert.equal(done.result.refresh.tokenEndpoint, `${BASE_URL}/v1/cloud/auth/app/token`);
  }
  assert.equal(requests[0]?.url, `${BASE_URL}/v1/cloud/auth/device/token`);
  assert.equal(requests[0]?.form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
  assert.equal(requests[0]?.form.get('device_code'), 'kordi_dc_synthetic');
});

test('an attempt waits its interval, slows down, and retries server errors', async () => {
  const { fetchImpl } = scriptedFetch([
    [200, CODE_BODY],
    [400, { error: 'authorization_pending' }],
    [400, { error: 'slow_down', interval: 10 }],
    [503, {}],
    [200, TOKEN_BODY],
  ]);
  const waits: number[] = [];
  const attempt = await DeviceCodeAttempt.start({
    baseUrl: BASE_URL, clientId: 'kordi-desktop', fetchImpl, driver,
    deviceRegistration: async () => DEVICE,
    sleep: async (ms) => { waits.push(ms); },
  });
  assert.equal(attempt.prompt.userCode, 'CDFG-HJKM');
  const result = await attempt.wait();
  assert.equal(result.session.token, 'kordi_cs_synthetic');
  assert.deepEqual(waits, [5_000, 5_000, 10_000, 15_000]);
});

test('canceling an attempt stops polling', async () => {
  const { fetchImpl, requests } = scriptedFetch([[200, CODE_BODY]]);
  const attempt = await DeviceCodeAttempt.start({
    baseUrl: BASE_URL, clientId: 'kordi-desktop', fetchImpl, driver,
    deviceRegistration: async () => DEVICE,
    sleep: async () => {},
  });
  const waiting = attempt.wait();
  attempt.cancel();
  await assert.rejects(waiting, (error: unknown) => error instanceof Error && error.name === 'BrowserSignInCancelledError');
  assert.equal(requests.length, 1, 'no poll after cancel');
});
