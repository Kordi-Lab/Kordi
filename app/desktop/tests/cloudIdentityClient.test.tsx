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

test('group invitation methods use the protected create, accept, and revoke routes', async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const responses = [
    {
      invitationId: 'groupinv_1',
      inviteUrl: 'https://kordi.ai/g/kordi_gi_token',
      expiresAt: '2026-08-15T00:00:00Z',
    },
    {
      invitations: [{ invitationId: 'groupinv_1', expiresAt: '2026-08-15T00:00:00Z' }],
    },
    {
      status: 'joined',
      groupId: 'session:group:1',
      groupSpaceId: 'session:group:1',
      groupTitle: 'Product Team',
    },
    null,
  ];
  const fetchImpl: typeof fetch = (input, init) => {
    calls.push({ url: input.toString(), init });
    const body = responses.shift();
    return Promise.resolve(new Response(body === null ? null : JSON.stringify(body), {
      status: body === null ? 204 : 200,
      headers: body === null ? undefined : { 'content-type': 'application/json' },
    }));
  };
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  const invitation = await client.createGroupInvitation('kordi_cs_admin', {
    groupId: 'session:group:1',
    groupSpaceId: 'session:group:1',
    groupTitle: 'Product Team',
  });
  const active = await client.listGroupInvitations('kordi_cs_admin', 'session:group:1');
  const acceptance = await client.acceptGroupInvitation('kordi_cs_recipient', 'kordi_gi_token');
  await client.revokeGroupInvitation('kordi_cs_admin', invitation.invitationId);

  assert.equal(invitation.inviteUrl, 'https://kordi.ai/g/kordi_gi_token');
  assert.equal(active[0]?.invitationId, 'groupinv_1');
  assert.equal(acceptance.status, 'joined');
  assert.equal(calls[0]?.url, 'http://srv/v1/cloud/invitations/groups');
  assert.equal(calls[0]?.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    groupId: 'session:group:1',
    groupSpaceId: 'session:group:1',
    groupTitle: 'Product Team',
  });
  assert.equal(calls[1]?.url, 'http://srv/v1/cloud/invitations/groups/active/session%3Agroup%3A1');
  assert.equal(calls[2]?.url, 'http://srv/v1/cloud/invitations/groups/accept/kordi_gi_token');
  assert.equal(calls[3]?.url, 'http://srv/v1/cloud/invitations/groups/groupinv_1');
  assert.equal(calls[3]?.init?.method, 'DELETE');
});

test('group invitation preview resolves without authentication', async () => {
  const { calls, client } = identityClient({
    inviter: { displayName: 'Ada', kordiId: '482731906', avatarUrl: null },
    group: { name: 'Product Team', memberCount: 3 },
    expiresAt: '2026-08-15T00:00:00Z',
  });

  const preview = await client.resolveGroupInvitation('kordi_gi_a/b');

  assert.equal(preview.group.name, 'Product Team');
  assert.equal(calls[0]?.url, 'http://srv/v1/cloud/invitations/groups/resolve/kordi_gi_a%2Fb');
  assert.deepEqual(calls[0]?.init?.headers, undefined);
});

test('pending group invitation methods claim, list, accept, and dismiss with bearer auth', async () => {
  const calls: Array<{ url: string; method: string | undefined; auth: string | null }> = [];
  const item = {
    id: 'gpi_1', invitationId: 'groupinv_1', groupName: 'Reading group',
    inviterName: 'Maya Chen', memberCount: 3, expiresAt: '2026-08-15T00:00:00Z',
  };
  const responses = [
    { pending: item, deepLink: 'kordi://group-invite/kordi_gi_token' },
    { invitations: [item] },
    { conversationId: 'session:group:1', status: 'joined', groupId: 'session:group:1', groupSpaceId: 'session:group:1', groupTitle: 'Reading group' },
    null,
  ];
  const fetchImpl: typeof fetch = (input, init) => {
    calls.push({ url: input.toString(), method: init?.method, auth: new Headers(init?.headers).get('authorization') });
    const body = responses.shift();
    return Promise.resolve(new Response(body === null ? null : JSON.stringify(body), {
      status: body === null ? 204 : 200,
      headers: body === null ? undefined : { 'content-type': 'application/json' },
    }));
  };
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  const claim = await client.claimGroupInvitation('kordi_cs_me', 'kordi_gi_token');
  const list = await client.listPendingGroupInvitations('kordi_cs_me');
  const accepted = await client.acceptPendingGroupInvitation('kordi_cs_me', 'gpi_1');
  await client.dismissPendingGroupInvitation('kordi_cs_me', 'gpi_1');

  assert.equal(claim.pending.id, 'gpi_1');
  assert.equal(list[0]?.groupName, 'Reading group');
  assert.equal(accepted.groupSpaceId, 'session:group:1');
  assert.deepEqual(calls.map(({ url, method }) => `${method} ${url}`), [
    'POST http://srv/v1/cloud/invitations/groups/claim/kordi_gi_token',
    'GET http://srv/v1/cloud/invitations/groups/pending',
    'POST http://srv/v1/cloud/invitations/groups/pending/gpi_1/accept',
    'DELETE http://srv/v1/cloud/invitations/groups/pending/gpi_1',
  ]);
  assert.ok(calls.every(({ auth }) => auth === 'Bearer kordi_cs_me'));
});
