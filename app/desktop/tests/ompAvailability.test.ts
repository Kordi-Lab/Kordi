import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CloudAuthClient } from '../src/features/cloud/authClient';
import { CloudAuthError } from '../src/features/cloud/cloudAuthError';
import {
  isOmpUnavailableError,
  isOmpUnavailableResponse,
  OMP_UNAVAILABLE_MESSAGE,
  OmpUnavailableError,
} from '../src/features/cloud/ompAvailability';
import { createCloudProviderAuthApi } from '../src/features/cloud/providerAuthClient';
import { createCloudProviderLoginClient, providerLoginErrorFromResponse, ProviderLoginError } from '../src/features/cloud/providerLogin';
import { loadPinnedOmpCatalog, refreshOmpCatalog } from '../src/kordi-app/auth/ompCatalog';

function jsonResponse(status: number, body: unknown) {
  return new Response(body === null ? 'Not Found' : JSON.stringify(body), { status, headers: { 'content-type': body === null ? 'text/plain' : 'application/json' } });
}

function providerAuthApi(status: number, body: unknown) {
  const calls: string[] = [];
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl: async (url) => {
    calls.push(new URL(String(url)).pathname);
    return jsonResponse(status, body);
  } });
  return { calls, api: createCloudProviderAuthApi(client) };
}

test('a missing route or OMP not configured is one state; a missing login session or a worker hiccup is not', () => {
  assert.equal(isOmpUnavailableResponse(404, null), true);
  assert.equal(isOmpUnavailableResponse(404, 'not_found'), true);
  assert.equal(isOmpUnavailableResponse(503, 'provider_auth_not_configured'), true);
  assert.equal(isOmpUnavailableResponse(503, 'omp_unavailable'), false, 'a restarting worker is transient');
  assert.equal(isOmpUnavailableResponse(404, 'login_not_found'), false);
  assert.equal(isOmpUnavailableResponse(503, 'omp_busy'), false);
  assert.equal(isOmpUnavailableResponse(503, null), false);
  assert.equal(new OmpUnavailableError().message, OMP_UNAVAILABLE_MESSAGE);
});

test('provider-auth routes on an older backend report OMP as unavailable', async () => {
  for (const [status, body] of [[404, null], [404, { errorCode: 'not_found' }], [503, { errorCode: 'provider_auth_not_configured', message: 'Provider sign-in is not set up on this server.' }]] as const) {
    const { api, calls } = providerAuthApi(status, body);
    await assert.rejects(api.ompProviderCatalog(), (caught) => caught instanceof OmpUnavailableError, `catalog ${status}`);
    await assert.rejects(api.validateOmpProviderKey('token', 'groq', 'value'), (caught) => isOmpUnavailableError(caught), `validate ${status}`);
    await assert.rejects(api.testProviderRoute('token', { provider: 'groq', authChoice: 'profile:work', model: 'groq/m', thinking: 'medium' }), (caught) => isOmpUnavailableError(caught), `test ${status}`);
    assert.deepEqual(calls, ['/v1/cloud/agent-provider-auth/catalog', '/v1/cloud/agent-provider-auth/validate-key', '/v1/cloud/agent-provider-auth/test-route'], 'one request each, no retries');
  }
  const busy = providerAuthApi(503, { errorCode: 'omp_busy' });
  await assert.rejects(busy.api.validateOmpProviderKey('token', 'groq', 'value'), (caught) => caught instanceof CloudAuthError && !isOmpUnavailableError(caught));
  const restarting = providerAuthApi(503, { errorCode: 'omp_unavailable', message: 'The OMP provider catalog could not be reached.' });
  await assert.rejects(restarting.api.ompProviderCatalog(), (caught) => caught instanceof CloudAuthError && !isOmpUnavailableError(caught));
});

test('sign-in sessions on an older backend report OMP as unavailable', async () => {
  const unavailable = providerLoginErrorFromResponse(404, null);
  assert.equal(unavailable.code, 'provider_auth_not_configured');
  assert.equal(unavailable.message, OMP_UNAVAILABLE_MESSAGE);
  assert.equal(isOmpUnavailableError(unavailable), true);
  assert.equal(isOmpUnavailableError(providerLoginErrorFromResponse(503, { errorCode: 'provider_auth_not_configured' })), true);
  const restarting = providerLoginErrorFromResponse(503, { errorCode: 'omp_unavailable' });
  assert.equal(restarting.code, 'omp_unavailable');
  assert.equal(isOmpUnavailableError(restarting), false, 'a restarting worker never turns OMP off for the page');
  assert.equal(providerLoginErrorFromResponse(404, { errorCode: 'login_not_found' }).code, 'login_not_found');
  assert.equal(isOmpUnavailableError(providerLoginErrorFromResponse(503, { errorCode: 'omp_busy' })), false);

  let requests = 0;
  const client = createCloudProviderLoginClient({
    baseUrl: () => 'http://127.0.0.1:9',
    token: async () => 'synthetic',
    fetchImpl: async () => { requests += 1; return jsonResponse(404, null); },
  });
  await assert.rejects(client.start({ provider: 'groq', label: 'Work', method: 'api-key' }), (caught) => caught instanceof ProviderLoginError && caught.ompUnavailable);
  assert.equal(requests, 1);
});

test('the pinned catalog keeps working when the hosted catalog is unavailable', async () => {
  const pinned = await loadPinnedOmpCatalog();
  const { api } = providerAuthApi(404, null);
  let reported = false;
  const kept = await refreshOmpCatalog(pinned, () => api.ompProviderCatalog().catch((caught: unknown) => {
    reported = isOmpUnavailableError(caught);
    throw caught;
  }));
  assert.equal(kept, pinned);
  assert.equal(reported, true);
});
