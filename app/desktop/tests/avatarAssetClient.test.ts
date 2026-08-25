import assert from 'node:assert/strict';
import test from 'node:test';

import { CloudAuthClient } from '../src/features/cloud/authClient';

test('signup uploads avatar bytes separately and activates the returned reference', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const uploadedAsset = 'kordi-avatar://uploaded/ava_0123456789abcdef0123456789abcdef';
  const avatar = (uploaded: boolean) => ({
    entityType: 'human',
    entityId: 'acct_1',
    source: uploaded ? 'uploaded' : 'generated',
    style: 'lorelei',
    seed: 'signup_seed',
    rendererVersion: 'dicebear-rust-10.6.0-styles-10.5.0',
    uploadedAsset: uploaded ? uploadedAsset : null,
    version: uploaded ? 2 : 1,
    updatedAt: '2026-08-25T00:00:00Z',
  });
  const account = (uploaded: boolean) => ({
    accountId: 'acct_1',
    displayName: 'Ada',
    primaryEmail: 'ada@example.com',
    avatarUrl: uploaded ? uploadedAsset : null,
    avatar: avatar(uploaded),
    passwordSet: true,
  });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('/avatar-assets')) {
      return Response.json({ uploadedAsset });
    }
    if (init?.method === 'PATCH') {
      return Response.json(account(true));
    }
    return Response.json({
      account: account(false),
      session: { token: 'kordi_cs_abc', expiresAt: '2099-01-01T00:00:00Z' },
    }, { status: 201 });
  };
  const client = new CloudAuthClient({
    baseUrl: 'http://srv',
    fetchImpl,
    deviceRegistration: async () => ({
      displayName: 'Ada’s Mac',
      platform: 'macos',
      osVersion: '15.6',
      appVersion: '0.0.1-beta.16',
      approximateLocation: 'Riyadh, Saudi Arabia',
      publicKey: 'test-public-key',
      keyAlgorithm: 'p256',
    }),
  });

  const result = await client.signup({
    email: 'ada@example.com',
    password: 'correct horse',
    displayName: 'Ada',
    avatarSeed: 'signup_seed',
    avatarMutation: { action: 'upload', uploadedAsset: 'data:image/jpeg;base64,/9j/' },
  });

  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'http://srv/v1/cloud/auth/signup');
  assert.equal(JSON.parse(calls[0].init?.body as string).avatarMutation, undefined);
  assert.match(calls[1].url, /\/v1\/cloud\/avatar-assets\?entityType=human&entityId=acct_1$/);
  assert.ok(calls[1].init?.body instanceof Blob);
  assert.deepEqual(JSON.parse(calls[2].init?.body as string).avatarMutation, {
    action: 'upload',
    uploadedAsset,
    expectedVersion: 1,
  });
  assert.equal(result.account.avatarUrl, uploadedAsset);
});
