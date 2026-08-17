import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CloudAuthClient } from '../src/features/cloud/authClient';
import {
  buildCloudProviderAuthSnapshotInput,
  cloudProviderAuthReconciliationSignature,
  cloudProviderAuthReconciliationTargets,
  cloudProviderAuthSnapshotRouteSignature,
  shouldPublishCloudProviderAuthSnapshot,
} from '../src/features/cloud/providerAuthSnapshot';
import {
  CloudProviderAuthSnapshotSyncGate,
  reconcileCloudProviderAuthSnapshots,
  type CloudProviderAuthSnapshotSyncOutcome,
} from '../src/features/cloud/useCloudProviderAuthSnapshotSync';

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('buildCloudProviderAuthSnapshotInput returns active provider and auth profile payload only when opt-in is enabled', () => {
  const input = buildCloudProviderAuthSnapshotInput({
    enabled: true,
    activeProvider: 'openai',
    activeAuthChoice: 'default',
    authProfiles: {
      openai: {
        default: { accessToken: 'tok_live', refreshToken: 'ref_live' },
        other: { accessToken: 'tok_other' },
      },
    },
  });

  assert.deepEqual(input, {
    provider: 'openai',
    authChoice: 'default',
    payload: { accessToken: 'tok_live', refreshToken: 'ref_live' },
  });
});

test('buildCloudProviderAuthSnapshotInput returns null without explicit opt-in', () => {
  const input = buildCloudProviderAuthSnapshotInput({
    enabled: false,
    activeProvider: 'openai',
    activeAuthChoice: 'default',
    authProfiles: {
      openai: { default: { accessToken: 'tok_live' } },
    },
  });

  assert.equal(input, null);
  assert.equal(shouldPublishCloudProviderAuthSnapshot(false, input), false);
});

test('cloud provider auth snapshot route signature changes only on account and auth route', () => {
  assert.equal(cloudProviderAuthSnapshotRouteSignature('acct_111', {
    model: 'gpt-5.5',
    authProvider: 'openai',
    authChoice: 'profile:codex',
  }), 'acct_111|openai|profile:codex|gpt-5.5');

  assert.equal(cloudProviderAuthSnapshotRouteSignature('acct_111', {
    model: 'gpt-5.5',
    authProvider: null,
    authChoice: 'profile:codex',
  }), null);

  assert.equal(cloudProviderAuthSnapshotRouteSignature('acct_111', {
    model: 'gpt-5.5',
    authProvider: 'openai-codex',
    authChoice: 'profile:codex',
  }), 'acct_111|openai|profile:codex|gpt-5.5');
});

test('provider auth reconciliation makes the online Mac authoritative across aliases', () => {
  const targets = cloudProviderAuthReconciliationTargets({
    authPath: '/redacted/auth.json',
    hasAnyAuth: true,
    providers: [
      {
        id: 'openai',
        label: 'OpenAI',
        statusSummary: 'Not configured',
        loginHint: '',
        envVar: '',
        helpUrl: '',
        supportsOAuth: true,
        supportsApiKey: true,
        configured: false,
        preferredModel: 'gpt-5.6-sol',
        options: [],
      },
      {
        id: 'anthropic',
        label: 'Claude',
        statusSummary: 'Connected',
        loginHint: '',
        envVar: '',
        helpUrl: '',
        supportsOAuth: true,
        supportsApiKey: true,
        configured: true,
        preferredModel: 'claude-sonnet-5',
        options: [{
          value: 'profile:claude',
          method: 'oauth',
          source: 'kordi auth.json',
          label: 'Claude subscription',
          active: true,
        }],
      },
      {
        id: 'ollama',
        label: 'Ollama',
        statusSummary: 'Local',
        loginHint: '',
        envVar: '',
        helpUrl: '',
        supportsOAuth: false,
        supportsApiKey: false,
        configured: true,
        options: [],
      },
    ],
  }, {
    model: 'anthropic/claude-opus-4-1',
    authProvider: 'anthropic',
    authChoice: 'local-active-oauth',
  });

  assert.deepEqual(targets, [
    {
      provider: 'openai',
      queryProviderIds: ['openai', 'openai-codex', 'codex'],
      configured: false,
      authChoice: null,
      model: 'gpt-5.6-sol',
    },
    {
      provider: 'anthropic',
      queryProviderIds: ['anthropic'],
      configured: true,
      authChoice: 'local-active-oauth',
      model: 'anthropic/claude-opus-4-1',
    },
  ]);
  assert.equal(
    cloudProviderAuthReconciliationSignature('acct_owner', targets),
    'acct_owner|openai:removed::gpt-5.6-sol|anthropic:configured:local-active-oauth:anthropic/claude-opus-4-1',
  );
});

test('provider auth snapshot sync gate confirms a signature only after successful publication', async () => {
  const gate = new CloudProviderAuthSnapshotSyncGate();
  const firstRun = deferred<CloudProviderAuthSnapshotSyncOutcome>();
  let starts = 0;
  const start = () => gate.start('acct_owner', 'route:a', () => {
    starts += 1;
    return firstRun.promise;
  });

  const firstTask = start();
  const repeatedTask = start();
  assert.equal(starts, 0);
  assert.equal(repeatedTask?.promise, firstTask?.promise);
  await Promise.resolve();
  assert.equal(starts, 1);

  firstRun.resolve('not-ready');
  assert.equal(await firstTask?.promise, 'not-ready');
  const retryTask = gate.start(
    'acct_owner',
    'route:a',
    async () => 'complete',
  );
  assert.notEqual(retryTask, null);
  assert.equal(await retryTask?.promise, 'complete');
  assert.equal(gate.start(
    'acct_owner',
    'route:a',
    async () => 'complete',
  ), null);

  const nextAccountTask = gate.start(
    'acct_other',
    'route:a',
    async () => 'complete',
  );
  assert.notEqual(nextAccountTask, null);
  assert.equal(await nextAccountTask?.promise, 'complete');
});

test('provider auth snapshot reconciliation publishes the active Mac profile without revoking aliases', async () => {
  const { calls, fetchImpl } = recordingFetch((call) => {
    if (call.url.endsWith('/v1/cloud/agent-provider-auth/snapshots')) {
      return jsonResponse(201, {
        snapshotId: 'snap_openai',
        provider: 'openai-codex',
        authChoice: 'local-active-oauth',
        createdAt: '2026-08-17T00:00:00Z',
        revokedAt: null,
      });
    }
    return jsonResponse(200, { snapshot: null });
  });
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });
  const payloadInputs: unknown[] = [];

  const outcome = await reconcileCloudProviderAuthSnapshots({
    accountId: 'acct_owner',
    client,
    route: {
      authProvider: 'openai-codex',
      authChoice: 'profile:openai',
      model: 'openai/gpt-5.6-sol',
    },
    desktopAuthState: {
      authPath: '/redacted/auth.json',
      hasAnyAuth: true,
      providers: [{
        id: 'openai',
        label: 'OpenAI',
        statusSummary: 'Connected',
        loginHint: '',
        envVar: '',
        helpUrl: '',
        supportsOAuth: true,
        supportsApiKey: true,
        configured: true,
        preferredModel: 'openai/gpt-5.6-sol',
        options: [{
          value: 'profile:openai',
          method: 'oauth',
          source: 'kordi auth.json',
          label: 'ChatGPT account',
          active: true,
        }],
      }],
    },
    isCurrent: () => true,
    loadStoredSession: async () => ({
      token: 'session_token',
      accountId: 'acct_owner',
      expiresAt: '2026-08-18T00:00:00Z',
    }),
    buildSnapshotPayload: async (input) => {
      payloadInputs.push(input);
      return {
        provider: 'openai-codex',
        authChoice: 'local-active-oauth',
        payload: { accessToken: 'redacted' },
      };
    },
  });

  assert.equal(outcome, 'complete');
  assert.deepEqual(payloadInputs, [{
    provider: 'openai',
    authChoice: 'profile:openai',
    model: 'openai/gpt-5.6-sol',
  }]);
  assert.equal(calls.filter((call) => call.init?.method === 'POST').length, 1);
  assert.equal(calls.filter((call) => call.init?.method === 'GET').length, 0);
  assert.equal(calls.filter((call) => call.init?.method === 'DELETE').length, 0);
});

test('provider auth snapshot reconciliation revokes every alias after the only provider is removed', async () => {
  let returnedOpenAiSnapshot = false;
  const { calls, fetchImpl } = recordingFetch((call) => {
    const provider = new URL(call.url).searchParams.get('provider');
    if (
      call.init?.method === 'GET'
      && provider === 'openai'
      && !returnedOpenAiSnapshot
    ) {
      returnedOpenAiSnapshot = true;
      return jsonResponse(200, {
        snapshot: {
          snapshotId: 'snap_removed',
          provider: 'openai',
          authChoice: 'local-active-api-key',
          createdAt: '2026-08-17T00:00:00Z',
          revokedAt: null,
        },
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
  assert.deepEqual(
    calls
      .filter((call) => call.init?.method === 'GET')
      .map((call) => new URL(call.url).searchParams.get('provider')),
    ['openai', 'openai', 'openai-codex', 'codex'],
  );
});

test('CloudAuthClient publishes current and revokes provider auth snapshots', async () => {
  const { calls, fetchImpl } = recordingFetch((call) => {
    if (call.url.endsWith('/v1/cloud/agent-provider-auth/snapshots')) {
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

  assert.equal(calls[0].url, 'http://srv/v1/cloud/agent-provider-auth/snapshots');
  assert.equal(calls[0].init?.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init?.body as string), {
    provider: 'openai',
    authChoice: 'default',
    payload: { accessToken: 'tok_live' },
  });
  assert.equal(calls[1].url, 'http://srv/v1/cloud/agent-provider-auth/snapshots/current?provider=openai&authChoice=default');
  assert.equal(calls[1].init?.method, 'GET');
  assert.equal(calls[2].url, 'http://srv/v1/cloud/agent-provider-auth/snapshots/snap_1');
  assert.equal(calls[2].init?.method, 'DELETE');
});
