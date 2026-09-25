import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CloudAuthClient } from '../src/features/cloud/authClient';
import { reconcileCloudProviderAuthSnapshots } from '../src/features/cloud/useCloudProviderAuthSnapshotSync';

// Removal and publication paths for hosted provider-auth snapshots; the
// signature and reconciliation-target cases live in cloudProviderAuthSnapshot.test.tsx.

type FetchCall = { url: string; init: RequestInit | undefined };

function recordingFetch(handler: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const call = { url, init };
    calls.push(call);
    return Promise.resolve(handler(call));
  };
  return { calls, fetchImpl };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('desktop logout removes only credentials synced from this device', async () => {
  const { calls, fetchImpl } = recordingFetch((call) => {
    if (call.init?.method === 'GET') {
      return jsonResponse(200, {
        snapshots: [{
          snapshotId: 'snap_removed',
          provider: 'openai',
          authChoice: 'local-active-api-key',
          createdAt: '2026-08-17T00:00:00Z',
          revokedAt: null,
        }, {
          snapshotId: 'snap_iphone',
          provider: 'openai-codex',
          authChoice: 'ios-codex:another-account',
          createdAt: '2026-08-17T00:00:00Z',
          revokedAt: null,
        }],
      });
    }
    if (call.init?.method === 'DELETE') {
      return jsonResponse(200, {
        snapshotId: 'snap_removed',
        provider: 'openai',
        authChoice: 'local-active-api-key',
        createdAt: '2026-08-17T00:00:00Z',
        revokedAt: '2026-08-17T00:01:00Z',
      });
    }
    return jsonResponse(200, { snapshot: null });
  });
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  const outcome = await reconcileCloudProviderAuthSnapshots({
    accountId: 'acct_owner',
    client,
    route: null,
    desktopAuthState: {
      authPath: '/redacted/auth.json',
      hasAnyAuth: false,
      providers: [{
        id: 'openai',
        label: 'OpenAI',
        statusSummary: 'Not configured',
        loginHint: '',
        envVar: '',
        helpUrl: '',
        supportsOAuth: true,
        supportsApiKey: true,
        configured: false,
        options: [],
      }],
    },
    intent: {
      providerId: 'openai',
      reason: 'provider-logout',
      revision: 1,
    },
    isCurrent: () => true,
    loadStoredSession: async () => ({
      token: 'session_token',
      accountId: 'acct_owner',
      expiresAt: '2026-08-18T00:00:00Z',
    }),
    buildSnapshotPayload: async () => null,
  });

  assert.equal(outcome, 'complete');
  assert.equal(calls.filter((call) => call.init?.method === 'POST').length, 0);
  assert.equal(calls.filter((call) => call.init?.method === 'DELETE').length, 1);
  assert.equal(calls.filter((call) => call.init?.method === 'GET').length, 1);
  assert.equal(new URL(calls.find((call) => call.init?.method === 'GET')!.url)
    .searchParams.get('currentDeviceOnly'), 'true');
});

test('removing one desktop profile keeps the second profile and iPhone account', async () => {
  const { calls, fetchImpl } = recordingFetch((call) => {
    if (call.init?.method === 'GET') return jsonResponse(200, { snapshots: [
      { snapshotId: 'snap_first', provider: 'openai-codex', authChoice: 'profile:first' },
      { snapshotId: 'snap_second', provider: 'openai-codex', authChoice: 'profile:second' },
    ] });
    if (call.init?.method === 'DELETE') return jsonResponse(200, {});
    return jsonResponse(201, {});
  });
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });
  const outcome = await reconcileCloudProviderAuthSnapshots({
    accountId: 'acct_owner', client,
    route: { authProvider: 'openai', authChoice: 'profile:second', model: 'openai/gpt-5.6-sol' },
    desktopAuthState: {
      authPath: '/redacted/auth.json', hasAnyAuth: true,
      providers: [{
        id: 'openai', label: 'OpenAI', statusSummary: 'Connected', loginHint: '',
        envVar: '', helpUrl: '', supportsOAuth: true, supportsApiKey: true,
        configured: true, options: [{
          value: 'profile:second', method: 'oauth', source: 'kordi auth.json',
          label: 'Second', active: true,
        }],
      }],
    },
    intent: { providerId: 'openai', profileId: 'first', reason: 'profile-removed', revision: 1 },
    isCurrent: () => true,
    loadStoredSession: async () => ({ token: 'session_token', accountId: 'acct_owner', expiresAt: '2026-08-18T00:00:00Z' }),
    buildSnapshotPayload: async () => ({ provider: 'openai-codex', authChoice: 'profile:second', payload: { accessToken: 'synthetic' } }),
  });
  assert.equal(outcome, 'complete');
  assert.equal(calls.filter((call) => call.init?.method === 'DELETE').length, 1);
  assert.match(calls.find((call) => call.init?.method === 'DELETE')!.url, /snap_first/);
  assert.equal(calls.filter((call) => call.init?.method === 'POST').length, 1);
});

test('one explicit desktop login syncs both saved Codex profiles', async () => {
  const published: string[] = [];
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl: async (_url, init) => {
    if (init?.method === 'POST') published.push(JSON.parse(String(init.body)).authChoice);
    return jsonResponse(201, {});
  } });
  const outcome = await reconcileCloudProviderAuthSnapshots({
    accountId: 'acct_owner', client,
    route: { authProvider: 'openai', authChoice: 'profile:first', model: 'openai/gpt-5.6-sol' },
    desktopAuthState: {
      authPath: '/redacted/auth.json', hasAnyAuth: true,
      providers: [{
        id: 'openai', label: 'OpenAI', statusSummary: 'Connected', loginHint: '',
        envVar: '', helpUrl: '', supportsOAuth: true, supportsApiKey: true,
        configured: true, options: [
          { value: 'profile:first', method: 'oauth', source: 'kordi auth.json', label: 'First', active: true },
          { value: 'profile:second', method: 'oauth', source: 'kordi auth.json', label: 'Second', active: false },
        ],
      }],
    },
    intent: { providerId: 'openai', reason: 'oauth-completed', revision: 1 },
    isCurrent: () => true,
    loadStoredSession: async () => ({ token: 'session_token', accountId: 'acct_owner', expiresAt: '2026-08-18T00:00:00Z' }),
    buildSnapshotPayload: async ({ authChoice }) => ({
      provider: 'openai-codex', authChoice: authChoice!, payload: { accessToken: 'synthetic' },
    }),
  });
  assert.equal(outcome, 'complete');
  assert.deepEqual(published, ['profile:first', 'profile:second']);
});

test('an unconfigured device cannot turn passive absence into provider removal', async () => {
  const { calls, fetchImpl } = recordingFetch(() => jsonResponse(500, {}));
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  const outcome = await reconcileCloudProviderAuthSnapshots({
    accountId: 'acct_owner',
    client,
    route: null,
    desktopAuthState: {
      authPath: '/redacted/auth.json',
      hasAnyAuth: false,
      providers: [{
        id: 'openai',
        label: 'OpenAI',
        statusSummary: 'Not configured',
        loginHint: '',
        envVar: '',
        helpUrl: '',
        supportsOAuth: true,
        supportsApiKey: true,
        configured: false,
        options: [],
      }],
    },
    intent: {
      providerId: 'openai',
      reason: 'oauth-completed',
      revision: 1,
    },
    isCurrent: () => true,
    loadStoredSession: async () => ({
      token: 'session_token',
      accountId: 'acct_owner',
      expiresAt: '2026-08-18T00:00:00Z',
    }),
    buildSnapshotPayload: async () => null,
  });

  assert.equal(outcome, 'not-ready');
  assert.equal(calls.length, 0);
});

test('CloudAuthClient publishes current and revokes provider auth snapshots', async () => {
  const { calls, fetchImpl } = recordingFetch((call) => {
    if (call.url.endsWith('/v1/cloud/agent-provider-auth/snapshots?intent=explicit')) {
      return jsonResponse(201, {
        snapshotId: 'snap_1',
        provider: 'openai',
        authChoice: 'default',
        createdAt: '2026-05-23T00:00:00Z',
        revokedAt: null,
      });
    }
    if (call.url.includes('/v1/cloud/agent-provider-auth/snapshots/current')) {
      return jsonResponse(200, {
        snapshot: {
          snapshotId: 'snap_1',
          provider: 'openai',
          authChoice: 'default',
          createdAt: '2026-05-23T00:00:00Z',
          revokedAt: null,
        },
      });
    }
    return jsonResponse(200, {
      snapshotId: 'snap_1',
      provider: 'openai',
      authChoice: 'default',
      createdAt: '2026-05-23T00:00:00Z',
      revokedAt: '2026-05-23T00:01:00Z',
    });
  });
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  const created = await client.publishProviderAuthSnapshot('kordi_cs_xyz', {
    provider: 'openai',
    authChoice: 'default',
    payload: { accessToken: 'tok_live' },
  });
  const current = await client.currentProviderAuthSnapshot('kordi_cs_xyz', {
    provider: 'openai',
    authChoice: 'default',
  });
  const revoked = await client.revokeProviderAuthSnapshot('kordi_cs_xyz', 'snap_1');

  assert.equal(created.snapshotId, 'snap_1');
  assert.equal(current?.snapshotId, 'snap_1');
  assert.equal(revoked.revokedAt, '2026-05-23T00:01:00Z');

  assert.equal(calls[0].url, 'http://srv/v1/cloud/agent-provider-auth/snapshots?intent=explicit');
  assert.equal(calls[0].init?.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init?.body as string), {
    provider: 'openai',
    authChoice: 'default',
    payload: { accessToken: 'tok_live' },
  });
  assert.equal(calls[1].url, 'http://srv/v1/cloud/agent-provider-auth/snapshots/current?provider=openai&authChoice=default');
  assert.equal(calls[1].init?.method, 'GET');
  assert.equal(calls[2].url, 'http://srv/v1/cloud/agent-provider-auth/snapshots/snap_1?intent=explicit');
  assert.equal(calls[2].init?.method, 'DELETE');
});
