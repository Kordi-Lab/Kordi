import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CloudAuthClient,
  CloudAuthError,
  cloudApiBaseUrl,
  cloudWebSocketUrl,
  parseCloudOAuthHashResult,
} from '../src/features/cloud/authClient';

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

test('signup posts JSON to the signup route and parses the response', async () => {
  const { calls, fetchImpl } = recordingFetch(() =>
    jsonResponse(201, {
      account: {
        accountId: 'acct_1',
        displayName: 'Ada',
        primaryEmail: 'ada@example.com',
        avatarUrl: null,
        passwordSet: true,
      },
      session: { token: 'kordi_cs_abc', expiresAt: '2099-01-01T00:00:00Z' },
    }),
  );
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  const result = await client.signup({
    email: 'ada@example.com',
    password: 'correct horse',
    displayName: 'Ada',
    avatarSeed: 'cloud-signup:1',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://srv/v1/cloud/auth/signup');
  assert.equal(calls[0].init?.method, 'POST');
  const body = JSON.parse(calls[0].init?.body as string);
  assert.deepEqual(body, {
    email: 'ada@example.com',
    password: 'correct horse',
    displayName: 'Ada',
    avatarSeed: 'cloud-signup:1',
  });
  assert.equal(result.session.token, 'kordi_cs_abc');
  assert.equal(result.account.passwordSet, true);
});

test('signup throws CloudAuthError with the server-supplied error code on 409', async () => {
  const { fetchImpl } = recordingFetch(() =>
    jsonResponse(409, { errorCode: 'email_in_use', message: 'Already in use.' }),
  );
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  await assert.rejects(
    () => client.signup({ email: 'a@b.com', password: 'correct horse' }),
    (caught: unknown) => {
      assert.ok(caught instanceof CloudAuthError);
      assert.equal((caught as CloudAuthError).code, 'email_in_use');
      assert.equal((caught as CloudAuthError).status, 409);
      return true;
    },
  );
});

test('login surfaces invalid_credentials on 401', async () => {
  const { fetchImpl } = recordingFetch(() =>
    jsonResponse(401, { errorCode: 'invalid_credentials', message: 'nope' }),
  );
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  await assert.rejects(
    () => client.login({ email: 'a@b.com', password: 'wrong' }),
    (caught: unknown) => {
      assert.ok(caught instanceof CloudAuthError);
      assert.equal((caught as CloudAuthError).code, 'invalid_credentials');
      return true;
    },
  );
});

test('logout sends Bearer token and treats 204 as success', async () => {
  const { calls, fetchImpl } = recordingFetch(() => new Response(null, { status: 204 }));
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  await client.logout('kordi_cs_xyz');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://srv/v1/cloud/auth/logout');
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer kordi_cs_xyz');
});

test('me returns the parsed account', async () => {
  const { fetchImpl } = recordingFetch(() =>
    jsonResponse(200, {
      accountId: 'acct_1',
      displayName: 'Ada',
      primaryEmail: 'ada@example.com',
      avatarUrl: null,
      passwordSet: true,
    }),
  );
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  const account = await client.me('kordi_cs_xyz');
  assert.equal(account.accountId, 'acct_1');
  assert.equal(account.passwordSet, true);
});

test('cloud API defaults to the public cloud origin, not localhost', () => {
  assert.equal(cloudApiBaseUrl({}), 'https://kordi.cloud');
  assert.equal(cloudApiBaseUrl({ VITE_KORDI_CLOUD_API_BASE: ' http://127.0.0.1:17081/ ' }), 'http://127.0.0.1:17081');
});

test('cloud WebSocket URL derives from the cloud API origin', () => {
  assert.equal(
    cloudWebSocketUrl('kordi_cs_token', 'https://kordi.cloud'),
    'wss://kordi.cloud/v1/cloud/ws?token=kordi_cs_token',
  );
  assert.equal(
    cloudWebSocketUrl('token with space', 'http://127.0.0.1:17081'),
    'ws://127.0.0.1:17081/v1/cloud/ws?token=token+with+space',
  );
});

test('network failures surface as CloudAuthError with code network_error', async () => {
  const fetchImpl: typeof fetch = () => Promise.reject(new TypeError('Failed to fetch'));
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  await assert.rejects(
    () => client.me('kordi_cs_xyz'),
    (caught: unknown) => {
      assert.ok(caught instanceof CloudAuthError);
      assert.equal((caught as CloudAuthError).code, 'network_error');
      return true;
    },
  );
});

test('markMessagesRead posts peer id to cloud read-receipt route', async () => {
  const { calls, fetchImpl } = recordingFetch(() => new Response(null, { status: 204 }));
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  await client.markMessagesRead('kordi_cs_xyz', 'acct_peer');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://srv/v1/cloud/messages/read');
  assert.equal(calls[0].init?.method, 'POST');
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer kordi_cs_xyz');
  assert.equal(headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init?.body as string), { peerAccountId: 'acct_peer' });
});

test('startOAuth requests a provider auth URL with redirectAfter', async () => {
  const { calls, fetchImpl } = recordingFetch(() => jsonResponse(200, { authUrl: 'https://accounts.example/auth' }));
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  const result = await client.startOAuth('google', 'http://127.0.0.1:1482/');

  assert.equal(result.authUrl, 'https://accounts.example/auth');
  assert.equal(calls[0].url, 'http://srv/v1/cloud/auth/oauth/google/start?redirectAfter=http%3A%2F%2F127.0.0.1%3A1482%2F');
  assert.equal(calls[0].init?.method, 'GET');
});

test('updateProfile patches cloud account profile fields', async () => {
  const { calls, fetchImpl } = recordingFetch(() => jsonResponse(200, {
    accountId: 'acct_1',
    displayName: 'Grace',
    primaryEmail: 'grace@example.com',
    avatarUrl: 'kordi-pixel-avatar://cloud-profile:1',
    nodeId: null,
    passwordSet: false,
  }));
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  const account = await client.updateProfile('kordi_cs_xyz', {
    displayName: 'Grace',
    avatarSeed: 'cloud-profile:1',
  });

  assert.equal(account.displayName, 'Grace');
  assert.equal(account.avatarUrl, 'kordi-pixel-avatar://cloud-profile:1');
  assert.equal(calls[0].url, 'http://srv/v1/cloud/auth/me');
  assert.equal(calls[0].init?.method, 'PATCH');
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer kordi_cs_xyz');
  assert.deepEqual(JSON.parse(calls[0].init?.body as string), {
    displayName: 'Grace',
    avatarSeed: 'cloud-profile:1',
  });
});

test('parseCloudOAuthHashResult decodes auth result fragments', () => {
  const payload = {
    account: {
      accountId: 'acct_1',
      displayName: 'Ada',
      primaryEmail: 'ada@example.com',
      avatarUrl: null,
      nodeId: null,
      passwordSet: false,
    },
    session: { token: 'kordi_cs_abc', expiresAt: '2099-01-01T00:00:00Z' },
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

  assert.deepEqual(parseCloudOAuthHashResult(`#kordi_cloud_oauth=${encoded}`), payload);
  assert.equal(parseCloudOAuthHashResult('#not_oauth=1'), null);
});

test('unknown server error codes degrade to "unknown"', async () => {
  const { fetchImpl } = recordingFetch(() =>
    jsonResponse(500, { errorCode: 'mystery_failure', message: 'something' }),
  );
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  await assert.rejects(
    () => client.login({ email: 'a@b.com', password: 'correct horse' }),
    (caught: unknown) => {
      assert.ok(caught instanceof CloudAuthError);
      assert.equal((caught as CloudAuthError).code, 'unknown');
      return true;
    },
  );
});
