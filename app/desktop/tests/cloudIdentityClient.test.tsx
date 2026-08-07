import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CloudAuthClient } from '../src/features/cloud/authClient';

function identityClient(responseBody: unknown) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl: typeof fetch = (input, init) => {
    calls.push({ url: input.toString(), init });
    return Promise.resolve(new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
  };
  return { calls, client: new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl }) };
}

test('me returns the public Kordi identity', async () => {
  const { client } = identityClient({
    accountId: 'acct_1',
    kordiId: '482731906',
    displayName: 'Ada',
    primaryEmail: 'ada@example.com',
    avatarUrl: null,
    passwordSet: true,
  });

  const account = await client.me('kordi_cs_xyz');

  assert.equal(account.accountId, 'acct_1');
  assert.equal(account.kordiId, '482731906');
  assert.equal(account.passwordSet, true);
});

test('createAppInvitation creates an expiring personal invitation with bearer auth', async () => {
  const { calls, client } = identityClient({
    invitationId: 'appinv_1',
    inviteUrl: 'https://kordi.ai/i/kordi_ai_token',
    expiresAt: '2026-08-14T00:00:00Z',
  });

  const invitation = await client.createAppInvitation('kordi_cs_xyz');

  assert.equal(invitation.inviteUrl, 'https://kordi.ai/i/kordi_ai_token');
  assert.equal(calls[0]?.url, 'http://srv/v1/cloud/invitations/app');
  assert.equal(calls[0]?.init?.method, 'POST');
  const headers = calls[0]?.init?.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer kordi_cs_xyz');
});
