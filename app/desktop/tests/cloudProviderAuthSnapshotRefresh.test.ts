import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CloudAuthClient } from '../src/features/cloud/authClient';
import { createProviderAuthPublishGate } from '../src/features/cloud/providerAuthPublishGate';
import { refreshCloudProviderAuthSnapshots } from '../src/features/cloud/useCloudProviderAuthSnapshotSync';
import type { DesktopAuthState } from '../src/kordi-app/types';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

function provider(id: string, configured: boolean, value: string): DesktopAuthState['providers'][number] {
  return {
    id, label: id, statusSummary: '', loginHint: '', envVar: '', helpUrl: '',
    supportsOAuth: true, supportsApiKey: true, configured, preferredModel: '',
    options: configured ? [{ value, method: 'oauth', source: 'kordi auth.json', label: id, active: true }] : [],
  };
}

test('periodic refresh republishes only providers whose local credential changed', async () => {
  const posts: unknown[] = [];
  const fetchImpl: typeof fetch = (_input, init) => {
    if (init?.method === 'POST') posts.push(JSON.parse(String(init.body)));
    return Promise.resolve(new Response(JSON.stringify({
      snapshotId: 'snap', provider: 'openai-codex', authChoice: 'local-active-oauth', createdAt: 'now', revokedAt: null,
    }), { status: 201, headers: { 'content-type': 'application/json' } }));
  };
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });
  const desktopAuthState: DesktopAuthState = {
    authPath: '/redacted/auth.json',
    hasAnyAuth: true,
    providers: [provider('openai', true, 'profile:mac'), provider('anthropic', false, '')],
  };
  let token = 'synthetic-access-1';
  const built: string[] = [];
  const publishGate = createProviderAuthPublishGate(memoryStorage());
  const refresh = (revision: number) => refreshCloudProviderAuthSnapshots({
    accountId: 'acct_owner',
    client,
    route: { authProvider: 'openai-codex', authChoice: 'local-active-oauth', model: 'openai/gpt-5.6-sol' },
    desktopAuthState,
    revision,
    isCurrent: () => true,
    loadStoredSession: async () => ({ token: 'session', accountId: 'acct_owner', expiresAt: '2099-01-01T00:00:00Z' }),
    buildSnapshotPayload: async (input) => {
      built.push(input.provider);
      return { provider: 'openai-codex', authChoice: input.authChoice ?? '', payload: { accessToken: token } };
    },
    publishGate,
  });

  // The route's alias and the profile it stands for are both kept current.
  assert.equal(await refresh(1), 'complete');
  assert.equal(posts.length, 2, 'first sync uploads the current credential');
  assert.equal(await refresh(2), 'complete');
  assert.equal(posts.length, 2, 'an unchanged credential is not uploaded again');
  token = 'synthetic-access-2';
  assert.equal(await refresh(3), 'complete');
  assert.equal(posts.length, 4, 'a locally refreshed credential is uploaded');
  assert.ok(built.every((id) => id === 'openai'), 'providers without a local sign-in are skipped');
});
