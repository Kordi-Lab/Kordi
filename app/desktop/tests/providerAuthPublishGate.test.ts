import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CloudAuthClient } from '../src/features/cloud/authClient';
import { createProviderAuthPublishGate, providerAuthSnapshotFingerprint } from '../src/features/cloud/providerAuthPublishGate';
import { reconcileCloudProviderAuthSnapshots } from '../src/features/cloud/useCloudProviderAuthSnapshotSync';
import type { DesktopAuthSyncIntent } from '../src/features/auth/desktopAuthSync';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

const snapshot = {
  provider: 'openai-codex',
  authChoice: 'profile:work',
  label: 'Work',
  payload: { apiMode: 'openai-codex-oauth', accessToken: 'synthetic-access-1', expiresAtMs: 1 },
};

test('the publish gate skips unchanged snapshots and republishes changes or explicit reconnects', async () => {
  const storage = memoryStorage();
  const gate = createProviderAuthPublishGate(storage);
  const first = await gate.shouldPublish('acct_owner', snapshot, false);
  assert.equal(first.publish, true);
  gate.record('acct_owner', snapshot, first.fingerprint);

  assert.equal((await gate.shouldPublish('acct_owner', snapshot, false)).publish, false);
  assert.equal((await gate.shouldPublish('acct_owner', snapshot, true)).publish, true, 'explicit reconnects always publish');
  assert.equal((await gate.shouldPublish('acct_owner', { ...snapshot, payload: { ...snapshot.payload, accessToken: 'synthetic-access-2' } }, false)).publish, true);
  assert.equal((await gate.shouldPublish('acct_owner', { ...snapshot, label: 'Work laptop' }, false)).publish, true);
  assert.equal((await gate.shouldPublish('acct_other', snapshot, false)).publish, true, 'fingerprints are per Kordi account');
  // Only fields in the fingerprint matter; the model or expiry alone does not republish.
  assert.equal((await gate.shouldPublish('acct_owner', { ...snapshot, payload: { ...snapshot.payload, model: 'gpt-5.5', expiresAtMs: 2 } }, false)).publish, false);

  const stored = [...storage.values.values()].join('');
  assert.doesNotMatch(stored, /synthetic-access/, 'only hashes are stored');
  assert.match(await providerAuthSnapshotFingerprint(snapshot), /^[0-9a-f]{64}$/);
});

test('without persistent storage every snapshot publishes', async () => {
  const gate = createProviderAuthPublishGate(null);
  const decision = await gate.shouldPublish('acct_owner', snapshot, false);
  gate.record('acct_owner', snapshot, decision.fingerprint);
  assert.equal((await gate.shouldPublish('acct_owner', snapshot, false)).publish, true);
});

test('sync publishes a desktop account once, then only on change or an explicit sign-in', async () => {
  const posts: Array<Record<string, unknown>> = [];
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl: async (_url, init) => {
    if (init?.method === 'POST') posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return new Response('{}', { status: 201, headers: { 'content-type': 'application/json' } });
  } });
  const publishGate = createProviderAuthPublishGate(memoryStorage());
  let accessToken = 'synthetic-access-1';
  const run = (intent: DesktopAuthSyncIntent) => reconcileCloudProviderAuthSnapshots({
    accountId: 'acct_owner', client, publishGate,
    route: { authProvider: 'openai', authChoice: 'profile:work', model: 'openai/gpt-5.5' },
    desktopAuthState: {
      authPath: '/redacted/auth.json', hasAnyAuth: true,
      providers: [{
        id: 'openai', label: 'OpenAI', statusSummary: 'Connected', loginHint: '', envVar: '', helpUrl: '',
        supportsOAuth: true, supportsApiKey: true, configured: true,
        options: [{ value: 'profile:work', method: 'oauth', source: 'kordi auth.json', label: 'Work', active: true }],
      }],
    },
    intent,
    isCurrent: () => true,
    loadStoredSession: async () => ({ token: 'session_token', accountId: 'acct_owner', expiresAt: '2099-01-01T00:00:00Z' }),
    buildSnapshotPayload: async () => ({
      provider: 'openai-codex', authChoice: 'profile:work', label: `${'Work '.repeat(30)}`,
      payload: { apiMode: 'openai-codex-oauth', accessToken, expiresAtMs: 1 },
    }),
  });

  assert.equal(await run({ providerId: 'openai', reason: 'active-choice-changed', revision: 1 }), 'complete');
  assert.equal(await run({ providerId: 'openai', reason: 'active-choice-changed', revision: 2 }), 'complete');
  assert.equal(posts.length, 1, 'an unchanged account is not republished');
  assert.equal(String(posts[0].label).length <= 80, true, 'labels are truncated before publishing');
  assert.equal('refreshToken' in (posts[0].payload as Record<string, unknown>), false);

  await run({ providerId: 'openai', profileId: 'work', reason: 'oauth-completed', revision: 3 });
  assert.equal(posts.length, 2, 'an explicit sign-in republishes');
  accessToken = 'synthetic-access-2';
  await run({ providerId: 'openai', reason: 'active-choice-changed', revision: 4 });
  assert.equal(posts.length, 3, 'a new access token republishes');
});
