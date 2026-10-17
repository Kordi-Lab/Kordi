import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CloudAuthClient } from '../src/features/cloud/authClient';
import { refreshCloudProviderAuthCopies } from '../src/features/cloud/providerAuthFreshness';
import { createProviderAuthPublishGate } from '../src/features/cloud/providerAuthPublishGate';
import type { DesktopAuthState } from '../src/kordi-app/types';

type Snapshot = { snapshotId: string; provider: string; authChoice: string };

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

/** A Cloud store with live snapshots from this device and from others. */
function cloud(here: Snapshot[], elsewhere: Snapshot[] = []) {
  const published: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    if (init?.method === 'POST') {
      published.push(JSON.parse(String(init.body)).authChoice);
      return new Response(JSON.stringify({ snapshotId: 'snap_new', provider: 'openai-codex', authChoice: 'x', createdAt: '', revokedAt: null }), { status: 201, headers: { 'content-type': 'application/json' } });
    }
    const snapshots = url.searchParams.get('currentDeviceOnly') === 'true' ? here : [...here, ...elsewhere];
    return new Response(JSON.stringify({ snapshots }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { client: new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl }), published };
}

const desktopAuthState: DesktopAuthState = {
  authPath: '/redacted/auth.json', hasAnyAuth: true,
  providers: [{
    id: 'openai', label: 'OpenAI', statusSummary: 'Connected', loginHint: '', envVar: '', helpUrl: '',
    supportsOAuth: true, supportsApiKey: true, configured: true,
    options: ['current', 'removed', 'shared'].map((id, index) => ({
      value: `profile:${id}`, method: 'oauth', source: 'kordi auth.json', label: id, active: index === 0,
    })),
  }],
};

/** The Mac's current access token for each profile. */
function macTokens(tokens: Record<string, string>) {
  return async ({ authChoice }: { authChoice?: string | null }) => ({
    provider: 'openai-codex', authChoice: authChoice!, payload: { accessToken: tokens[authChoice!] },
  });
}

const session = async () => ({ token: 'session_token', accountId: 'acct_owner', expiresAt: '2026-12-01T00:00:00Z' });

test('the Mac keeps its Cloud copies current without re-adding removed or overriding shared accounts', async () => {
  const publishGate = createProviderAuthPublishGate(memoryStorage());
  // This Mac uploaded "current" and "removed" before; "removed" was deleted
  // on another device since. "shared" lives in Cloud from another device.
  publishGate.record('acct_owner', { provider: 'openai-codex', authChoice: 'profile:current' }, 'old-token-fingerprint');
  publishGate.record('acct_owner', { provider: 'openai-codex', authChoice: 'profile:removed' }, 'old-token-fingerprint');
  const store = cloud(
    [{ snapshotId: 'snap_current', provider: 'openai-codex', authChoice: 'profile:current' }],
    [{ snapshotId: 'snap_shared', provider: 'openai-codex', authChoice: 'profile:shared' }],
  );
  const options = {
    accountId: 'acct_owner', client: store.client, route: null, desktopAuthState,
    isCurrent: () => true, loadStoredSession: session, publishGate,
    buildSnapshotPayload: macTokens({ 'profile:current': 'refreshed', 'profile:removed': 'r', 'profile:shared': 's' }),
  };

  assert.equal(await refreshCloudProviderAuthCopies(options), 1);
  assert.deepEqual(store.published, ['profile:current'], 'only the refreshed token is uploaded');
  assert.equal(await refreshCloudProviderAuthCopies(options), 0, 'an unchanged token is not uploaded again');
});

test('an account Cloud has never seen from any device is uploaded once', async () => {
  const publishGate = createProviderAuthPublishGate(memoryStorage());
  const store = cloud([]);
  const options = {
    accountId: 'acct_owner', client: store.client, route: null, desktopAuthState,
    isCurrent: () => true, loadStoredSession: session, publishGate,
    buildSnapshotPayload: macTokens({ 'profile:current': 'a', 'profile:removed': 'b', 'profile:shared': 'c' }),
  };
  assert.equal(await refreshCloudProviderAuthCopies(options), 3);
  // Cloud still lists nothing, as if each upload was deleted elsewhere right away.
  assert.equal(await refreshCloudProviderAuthCopies(options), 0, 'an upload deleted since is never re-added');
});

test('nothing is uploaded for another Cloud account or without a configured provider', async () => {
  const store = cloud([]);
  const base = {
    client: store.client, route: null, isCurrent: () => true, loadStoredSession: session,
    publishGate: createProviderAuthPublishGate(memoryStorage()),
    buildSnapshotPayload: macTokens({ 'profile:current': 'a' }),
  };
  assert.equal(await refreshCloudProviderAuthCopies({ ...base, accountId: 'acct_other', desktopAuthState }), 0);
  const signedOut = { ...desktopAuthState, providers: desktopAuthState.providers.map((provider) => ({ ...provider, configured: false })) };
  assert.equal(await refreshCloudProviderAuthCopies({ ...base, accountId: 'acct_owner', desktopAuthState: signedOut }), 0);
  assert.deepEqual(store.published, []);
});
