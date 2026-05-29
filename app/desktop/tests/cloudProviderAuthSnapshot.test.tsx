import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CloudAuthClient } from '../src/features/cloud/authClient';
import {
  buildCloudProviderAuthSnapshotInput,
  cloudProviderAuthSnapshotRouteSignature,
  shouldPublishCloudProviderAuthSnapshot,
} from '../src/features/cloud/providerAuthSnapshot';

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
  }), 'acct_111|openai|profile:codex|gpt-5.5');

  assert.equal(cloudProviderAuthSnapshotRouteSignature('acct_111', {
    model: 'gpt-5.5',
    authProvider: null,
    authChoice: 'profile:codex',
  }), null);
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
