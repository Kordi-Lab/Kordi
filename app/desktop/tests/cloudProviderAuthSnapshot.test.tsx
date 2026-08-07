import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { CloudAuthClient } from '../src/features/cloud/authClient';
import {
  buildCloudProviderAuthSnapshotInput,
  canReconcileCloudProviderAuthManifest,
  cloudProviderAuthAccountRevision,
  cloudProviderAuthSnapshotIdentity,
  cloudProviderAuthSnapshotRouteSignature,
  cloudProviderAuthSyncTargets,
  retargetCloudAgentModelRoutingForAuthState,
  shouldPublishCloudProviderAuthSnapshot,
} from '../src/features/cloud/providerAuthSnapshot';

test('provider auth reconciliation stays blocked until this account restores successfully', () => {
  assert.equal(canReconcileCloudProviderAuthManifest('acct_shu', null), false);
  assert.equal(canReconcileCloudProviderAuthManifest('acct_shu', 'acct_ufish'), false);
  assert.equal(canReconcileCloudProviderAuthManifest('acct_shu', 'acct_shu'), true);

  const source = readFileSync(new URL(
    '../src/features/cloud/useCloudProviderAuthSnapshotSync.ts',
    import.meta.url,
  ), 'utf8');
  const revokeStart = source.indexOf('revokeProviderAuthSnapshot');
  assert.notEqual(revokeStart, -1);
  assert.match(
    source.slice(0, revokeStart),
    /canReconcileCloudProviderAuthManifest\([\s\S]*restoreReadyAccountIdRef\.current/,
    'a device that could not restore the account manifest must never revoke its snapshots',
  );
});

test('provider auth synchronization is independent from chat hydration', () => {
  const providerSyncSource = readFileSync(new URL(
    '../src/features/cloud/useCloudProviderAuthSnapshotSync.ts',
    import.meta.url,
  ), 'utf8');
  const agentSyncSource = readFileSync(new URL(
    '../src/features/cloud/useCloudAgentProviderAuthSync.ts',
    import.meta.url,
  ), 'utf8');

  assert.doesNotMatch(providerSyncSource, /initialMessagesSettled/);
  assert.doesNotMatch(agentSyncSource, /initialMessagesSettled/);
});

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
  }), 'acct_111|openai|profile:codex|gpt-5.5|');

  assert.equal(cloudProviderAuthSnapshotRouteSignature('acct_111', {
    model: 'gpt-5.5',
    authProvider: null,
    authChoice: 'profile:codex',
  }), null);
});

test('cloud provider auth revision follows the active account profile update', () => {
  const route = {
    model: 'anthropic/claude-opus-4-8',
    authProvider: 'anthropic',
    authChoice: 'profile:claude',
  };
  const first = cloudProviderAuthAccountRevision({
    authPath: '/account/auth.json',
    hasAnyAuth: true,
    providers: [{
      id: 'anthropic',
      label: 'Claude',
      statusSummary: 'configured',
      loginHint: '',
      envVar: '',
      helpUrl: '',
      supportsOAuth: true,
      supportsApiKey: true,
      configured: true,
      options: [{
        value: 'profile:claude',
        profileId: 'claude',
        method: 'oauth',
        source: 'kordi',
        label: 'Claude subscription',
        active: true,
        updatedAtMs: 100,
      }],
    }],
  }, route);
  const second = first?.replace('100', '200') ?? null;

  assert.notEqual(first, second);
  assert.notEqual(
    cloudProviderAuthSnapshotRouteSignature('acct_111', route, first),
    cloudProviderAuthSnapshotRouteSignature('acct_111', route, second),
  );
});

test('cloud provider auth revision ignores routes whose provider is not configured', () => {
  const revision = cloudProviderAuthAccountRevision({
    authPath: '/account/auth.json',
    hasAnyAuth: true,
    providers: [{
      id: 'openai',
      label: 'OpenAI',
      statusSummary: 'not configured',
      loginHint: '',
      envVar: '',
      helpUrl: '',
      supportsOAuth: true,
      supportsApiKey: true,
      configured: false,
      options: [],
    }],
  }, {
    model: 'openai/gpt-5.6-sol',
    authProvider: 'openai',
    authChoice: 'profile:missing',
  });

  assert.equal(revision, null);
});

test('cloud provider auth sync targets include every saved profile but exclude environment and local providers', () => {
  const sharedOptions = [
    {
      value: 'profile:oauth-one',
      profileId: 'oauth-one',
      method: 'OAuth',
      source: 'kordi auth.json',
      label: 'ChatGPT account',
      active: true,
    },
    {
      value: 'profile:key-one',
      profileId: 'key-one',
      method: 'API key',
      source: 'kordi auth.json',
      label: 'Saved API key',
      active: false,
    },
    {
      value: 'env:api-key',
      method: 'API key',
      source: 'environment',
      label: 'Environment API key',
      active: false,
    },
  ];
  const targets = cloudProviderAuthSyncTargets({
    authPath: '/account/auth.json',
    hasAnyAuth: true,
    providers: [
      {
        id: 'openai-codex',
        label: 'ChatGPT',
        statusSummary: 'configured',
        loginHint: '',
        envVar: '',
        helpUrl: '',
        supportsOAuth: true,
        supportsApiKey: true,
        configured: true,
        options: sharedOptions,
      },
      {
        id: 'openai',
        label: 'OpenAI',
        statusSummary: 'configured',
        loginHint: '',
        envVar: '',
        helpUrl: '',
        supportsOAuth: true,
        supportsApiKey: true,
        configured: true,
        options: sharedOptions,
      },
      {
        id: 'ollama',
        label: 'Ollama',
        statusSummary: 'configured',
        loginHint: '',
        envVar: '',
        helpUrl: '',
        supportsOAuth: false,
        supportsApiKey: true,
        configured: true,
        options: [{
          value: 'profile:local',
          profileId: 'local',
          method: 'API key',
          source: 'kordi auth.json',
          label: 'Local key',
          active: true,
        }],
      },
    ],
  });

  assert.deepEqual(targets, [
    {
      provider: 'openai-codex',
      authChoice: 'profile:oauth-one',
      model: null,
      active: true,
    },
    {
      provider: 'openai',
      authChoice: 'profile:key-one',
      model: null,
      active: false,
    },
  ]);
  assert.equal(
    cloudProviderAuthSnapshotIdentity('OpenAI-Codex', 'profile:oauth-one'),
    'openai-codex|profile:oauth-one',
  );
});

test('cloud agent routing follows an unambiguous replacement auth profile', () => {
  const authState = {
    authPath: '/account/auth.json',
    hasAnyAuth: true,
    providers: [{
      id: 'anthropic',
      label: 'Claude',
      statusSummary: 'configured',
      loginHint: '',
      envVar: '',
      helpUrl: '',
      supportsOAuth: true,
      supportsApiKey: true,
      configured: true,
      options: [{
        value: 'profile:claude-new',
        profileId: 'claude-new',
        method: 'OAuth',
        source: 'kordi auth.json',
        label: 'Claude subscription',
        active: true,
      }],
    }],
  };

  assert.deepEqual(retargetCloudAgentModelRoutingForAuthState({
    defaultModel: 'anthropic/claude-opus-4-8',
    defaultAuthProvider: 'anthropic-oauth',
    defaultAuthChoice: 'profile:claude-revoked',
    fallbackAuthProvider: 'anthropic',
    fallbackAuthChoice: 'profile:claude-revoked',
  }, authState), {
    defaultModel: 'anthropic/claude-opus-4-8',
    defaultAuthProvider: 'anthropic-oauth',
    defaultAuthChoice: 'profile:claude-new',
    fallbackAuthProvider: 'anthropic',
    fallbackAuthChoice: 'profile:claude-new',
  });

  assert.equal(retargetCloudAgentModelRoutingForAuthState({
    defaultAuthProvider: 'anthropic',
    defaultAuthChoice: 'profile:claude-new',
  }, authState), null);
});

test('cloud agent routing does not guess between multiple active auth profiles', () => {
  const options = ['claude-one', 'claude-two'].map((profileId) => ({
    value: `profile:${profileId}`,
    profileId,
    method: 'OAuth',
    source: 'kordi auth.json',
    label: profileId,
    active: true,
  }));
  assert.equal(retargetCloudAgentModelRoutingForAuthState({
    defaultAuthProvider: 'anthropic',
    defaultAuthChoice: 'profile:claude-revoked',
  }, {
    authPath: '/account/auth.json',
    hasAnyAuth: true,
    providers: [{
      id: 'anthropic',
      label: 'Claude',
      statusSummary: 'configured',
      loginHint: '',
      envVar: '',
      helpUrl: '',
      supportsOAuth: true,
      supportsApiKey: true,
      configured: true,
      options,
    }],
  }), null);
});

test('CloudAuthClient loads the complete provider auth manifest', async () => {
  const { calls, fetchImpl } = recordingFetch(() => jsonResponse(200, {
    syncRevision: 'rev_1',
    snapshots: [{
      snapshotId: 'snap_1',
      provider: 'anthropic',
      authChoice: 'profile:claude',
      createdAt: '2026-08-07T00:00:00Z',
      revokedAt: null,
    }],
  }));
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  const manifest = await client.providerAuthSnapshotManifest('kordi_cs_xyz');

  assert.equal(manifest.syncRevision, 'rev_1');
  assert.equal(manifest.snapshots[0]?.snapshotId, 'snap_1');
  assert.equal(calls[0]?.url, 'http://srv/v1/cloud/agent-provider-auth/snapshots/manifest');
  assert.equal(calls[0]?.init?.method, 'GET');
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
