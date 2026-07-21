import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CloudAuthClient,
  CloudAuthError,
  cloudApiBaseUrl,
  operatorCloudOAuthProviderFallback,
  cloudRealtimeWebSocketEnabled,
  cloudWebSocketUrl,
  defaultCloudRequestTimeoutMs,
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
  const avatarUrl = 'data:image/jpeg;base64,abc';
  const { calls, fetchImpl } = recordingFetch(() =>
    jsonResponse(201, {
      account: {
        accountId: 'acct_1',
        displayName: 'Ada',
        primaryEmail: 'ada@example.com',
        avatarUrl,
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
    avatarUrl,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://srv/v1/cloud/auth/signup');
  assert.equal(calls[0].init?.method, 'POST');
  const body = JSON.parse(calls[0].init?.body as string);
  assert.deepEqual(body, {
    email: 'ada@example.com',
    password: 'correct horse',
    displayName: 'Ada',
    avatarUrl,
  });
  assert.equal(result.session.token, 'kordi_cs_abc');
  assert.equal(result.account.passwordSet, true);
  assert.equal(result.account.avatarUrl, avatarUrl);
});

test('signup throws missing_avatar when the server requires an upload', async () => {
  const { fetchImpl } = recordingFetch(() =>
    jsonResponse(400, { errorCode: 'missing_avatar', message: 'Upload an avatar to sign up.' }),
  );
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  await assert.rejects(
    () => client.signup({ email: 'a@b.com', password: 'correct horse' }),
    (caught: unknown) => {
      assert.ok(caught instanceof CloudAuthError);
      assert.equal((caught as CloudAuthError).code, 'missing_avatar');
      assert.equal((caught as CloudAuthError).status, 400);
      return true;
    },
  );
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

test('requests abort with a CloudAuthError instead of leaving lookup UI stuck forever', async () => {
  const fetchImpl: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    });
  });
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl, requestTimeoutMs: 5 });

  await assert.rejects(
    () => client.getProfile('kordi_cs_abc', 'acct_1'),
    (caught: unknown) => {
      assert.ok(caught instanceof CloudAuthError);
      assert.equal((caught as CloudAuthError).code, 'network_error');
      assert.match((caught as CloudAuthError).message, /timed out/i);
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

test('publishPresenceOffline uses keepalive so page close can finish the request', async () => {
  const { calls, fetchImpl } = recordingFetch(() => jsonResponse(200, {
    accountId: 'acct_1',
    status: 'offline',
    updatedAt: '2026-05-23T00:00:00Z',
  }));
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  await client.publishPresenceOffline('kordi_cs_xyz');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://srv/v1/cloud/presence/offline');
  assert.equal(calls[0].init?.keepalive, true);
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

test('capabilities reports only server-configured social sign-in providers', async () => {
  const { calls, fetchImpl } = recordingFetch(() => jsonResponse(200, {
    password: true,
    oauthProviders: ['github'],
  }));
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  const capabilities = await client.capabilities();

  assert.deepEqual(capabilities, { password: true, oauthProviders: ['github'] });
  assert.equal(calls[0].url, 'http://srv/v1/cloud/auth/capabilities');
  assert.equal(calls[0].init?.method, 'GET');
});

test('cloud API defaults to the hosted product origin outside development', () => {
  assert.equal(cloudApiBaseUrl({}), 'https://coordinar.io');
});

test('development cloud API requires an explicit non-production origin', () => {
  assert.throws(
    () => cloudApiBaseUrl({ DEV: true }),
    /VITE_KORDI_CLOUD_API_BASE is required for development/i,
  );
  for (const productionOrigin of [
    'https://coordinar.io:443/',
    'http://coordinar.io',
    'https://coordinar.io./',
  ]) {
    assert.throws(
      () => cloudApiBaseUrl({
        DEV: true,
        VITE_KORDI_CLOUD_API_BASE: productionOrigin,
      }),
      /production Cloud API is blocked in development/i,
    );
  }
  assert.equal(
    cloudApiBaseUrl({
      DEV: true,
      VITE_KORDI_CLOUD_API_BASE: ' http://127.0.0.1:17081/ ',
    }),
    'http://127.0.0.1:17081',
  );
  assert.equal(
    cloudApiBaseUrl({
      DEV: true,
      VITE_KORDI_CLOUD_API_BASE: 'https://staging.example.test/',
    }),
    'https://staging.example.test',
  );
});

test('operator development requires both the operator profile and production acknowledgement', () => {
  const baseEnv = {
    DEV: true,
    VITE_KORDI_CLOUD_API_BASE: 'https://coordinar.io',
  };
  assert.throws(
    () => cloudApiBaseUrl({ ...baseEnv, VITE_KORDI_DEV_PROFILE: 'operator' }),
    /blocked in development/i,
  );
  assert.throws(
    () => cloudApiBaseUrl({ ...baseEnv, VITE_KORDI_PRODUCTION_DEBUG_ACK: '1' }),
    /blocked in development/i,
  );
  assert.equal(
    cloudApiBaseUrl({
      ...baseEnv,
      VITE_KORDI_DEV_PROFILE: 'operator',
      VITE_KORDI_PRODUCTION_DEBUG_ACK: '1',
    }),
    'https://coordinar.io',
  );
});

test('acknowledged production operator previews retain OAuth when capability discovery is unavailable', () => {
  const operatorEnv = {
    DEV: true,
    VITE_KORDI_CLOUD_API_BASE: 'https://coordinar.io',
    VITE_KORDI_DEV_PROFILE: 'operator',
    VITE_KORDI_PRODUCTION_DEBUG_ACK: '1',
  };
  assert.deepEqual(operatorCloudOAuthProviderFallback(operatorEnv), ['google', 'github']);
  assert.deepEqual(operatorCloudOAuthProviderFallback({
    ...operatorEnv,
    VITE_KORDI_DEV_PROFILE: 'community',
  }), []);
  assert.deepEqual(operatorCloudOAuthProviderFallback({
    ...operatorEnv,
    VITE_KORDI_PRODUCTION_DEBUG_ACK: undefined,
  }), []);
  assert.deepEqual(operatorCloudOAuthProviderFallback({
    ...operatorEnv,
    VITE_KORDI_CLOUD_API_BASE: 'https://staging.example.test',
  }), []);
});

test('cloud auth client gives local SSH tunnels a longer default timeout', () => {
  assert.equal(defaultCloudRequestTimeoutMs('https://coordinar.io'), 15_000);
  assert.equal(defaultCloudRequestTimeoutMs('http://127.0.0.1:17081'), 45_000);
  assert.equal(defaultCloudRequestTimeoutMs('http://localhost:17081'), 45_000);
});

test('cloud realtime WebSockets stay off for local SSH tunnel tests', () => {
  assert.equal(cloudRealtimeWebSocketEnabled('https://coordinar.io'), true);
  assert.equal(cloudRealtimeWebSocketEnabled('http://127.0.0.1:17081'), false);
  assert.equal(cloudRealtimeWebSocketEnabled('http://localhost:17081'), false);
});

test('cloud WebSocket URL derives from the cloud API origin', () => {
  assert.equal(
    cloudWebSocketUrl('kordi_cs_token', 'https://coordinar.io'),
    'wss://coordinar.io/v1/cloud/ws?token=kordi_cs_token',
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

test('claimCloudAgentRun posts typed claim request and parses status response', async () => {
  const { calls, fetchImpl } = recordingFetch(() => jsonResponse(200, {
    runId: 'car_1',
    status: 'queued',
    sandboxId: 'cas_1',
    createdAt: '2026-05-24T00:00:00Z',
    updatedAt: '2026-05-24T00:00:00Z',
  }));
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  const run = await client.claimCloudAgentRun('kordi_cs_xyz', {
    requestMessageId: 'msg_1',
    sessionId: 'session:direct-person:acct_owner:acct_requester',
    ownerAccountId: 'acct_owner',
    requesterAccountId: 'acct_requester',
    prompt: 'hello',
    idempotencyKey: 'cloud-fallback:msg_1',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://srv/v1/cloud/agent-runs/claim');
  assert.equal(calls[0].init?.method, 'POST');
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer kordi_cs_xyz');
  assert.deepEqual(JSON.parse(calls[0].init?.body as string), {
    requestMessageId: 'msg_1',
    sessionId: 'session:direct-person:acct_owner:acct_requester',
    ownerAccountId: 'acct_owner',
    requesterAccountId: 'acct_requester',
    prompt: 'hello',
    idempotencyKey: 'cloud-fallback:msg_1',
  });
  assert.deepEqual(run, {
    runId: 'car_1',
    status: 'queued',
    sandboxId: 'cas_1',
    createdAt: '2026-05-24T00:00:00Z',
    updatedAt: '2026-05-24T00:00:00Z',
  });
});

test('sendMessage posts attachment metadata and parses returned attachments', async () => {
  const { calls, fetchImpl } = recordingFetch(() => jsonResponse(201, {
    message: {
      messageId: 'msg_1',
      fromAccountId: 'acct_me',
      toAccountId: 'acct_peer',
      body: 'see file',
      createdAt: '2026-05-12T00:00:00Z',
      deliveredAt: null,
      readAt: null,
      direction: 'outgoing',
      attachments: [{
        attachmentId: 'att_1',
        name: 'report.pdf',
        kind: 'file',
        mimeType: 'application/pdf',
        sizeBytes: 1000,
        downloadUrl: 'https://files.test/att_1',
        previewUrl: null,
      }],
    },
  }));
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  const sent = await client.sendMessage('kordi_cs_xyz', 'acct_peer', 'see file', {
    sessionId: 'session-1',
    clientMessageId: 'msg:canonical:one:acct_peer',
    attachments: [{
      attachmentId: 'att_1',
      name: 'report.pdf',
      kind: 'file',
      mimeType: 'application/pdf',
      sizeBytes: 1000,
    }],
  });

  assert.equal(calls[0].url, 'http://srv/v1/cloud/messages');
  assert.deepEqual(JSON.parse(calls[0].init?.body as string), {
    peerAccountId: 'acct_peer',
    body: 'see file',
    sessionId: 'session-1',
    clientMessageId: 'msg:canonical:one:acct_peer',
    attachments: [{
      attachmentId: 'att_1',
      name: 'report.pdf',
      kind: 'file',
      mimeType: 'application/pdf',
      sizeBytes: 1000,
    }],
  });
  assert.equal(sent.attachments?.[0]?.downloadUrl, 'https://files.test/att_1');
});

test('listSessionVisibility loads hidden and deleted cloud session ids', async () => {
  const { calls, fetchImpl } = recordingFetch(() => jsonResponse(200, {
    hiddenSessionIds: ['session:hidden'],
    deletedSessionIds: ['session:deleted'],
  }));
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  const visibility = await client.listSessionVisibility('kordi_cs_xyz');

  assert.equal(calls[0].url, 'http://srv/v1/cloud/sessions/visibility');
  assert.equal(calls[0].init?.method, 'GET');
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer kordi_cs_xyz');
  assert.deepEqual(visibility, {
    hiddenSessionIds: ['session:hidden'],
    deletedSessionIds: ['session:deleted'],
  });
});

test('hideCloudSession sends an authenticated PUT to the hidden route', async () => {
  const { calls, fetchImpl } = recordingFetch(() => new Response(null, { status: 204 }));
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  await client.hideCloudSession('kordi_cs_xyz', 'session:one');

  assert.equal(calls[0].url, 'http://srv/v1/cloud/sessions/session%3Aone/hidden');
  assert.equal(calls[0].init?.method, 'PUT');
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer kordi_cs_xyz');
});

test('unhideCloudSession sends an authenticated DELETE to the hidden route', async () => {
  const { calls, fetchImpl } = recordingFetch(() => new Response(null, { status: 204 }));
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  await client.unhideCloudSession('kordi_cs_xyz', 'session:one');

  assert.equal(calls[0].url, 'http://srv/v1/cloud/sessions/session%3Aone/hidden');
  assert.equal(calls[0].init?.method, 'DELETE');
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer kordi_cs_xyz');
});

test('deleteCloudSession sends an authenticated DELETE to the session route', async () => {
  const { calls, fetchImpl } = recordingFetch(() => new Response(null, { status: 204 }));
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  await client.deleteCloudSession('kordi_cs_xyz', 'session:one');

  assert.equal(calls[0].url, 'http://srv/v1/cloud/sessions/session%3Aone');
  assert.equal(calls[0].init?.method, 'DELETE');
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer kordi_cs_xyz');
});

test('listSessionForks loads cloud fork lineage for a parent session', async () => {
  const { calls, fetchImpl } = recordingFetch(() => jsonResponse(200, {
    forks: [{
      forkSessionId: 'session:fork:child',
      parentSessionId: 'session:parent',
      parentMessageId: 'msg:parent',
      createdByAccountId: 'acct_me',
      createdAt: '2026-05-16T10:00:00Z',
    }],
  }));
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  const forks = await client.listSessionForks('kordi_cs_xyz', 'session:parent');

  assert.equal(calls[0].url, 'http://srv/v1/cloud/sessions/session%3Aparent/forks');
  assert.equal(calls[0].init?.method, 'GET');
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer kordi_cs_xyz');
  assert.equal(forks[0]?.forkSessionId, 'session:fork:child');
});

test('uploadAttachment initiates then proxies bytes through the cloud API', async () => {
  const { calls, fetchImpl } = recordingFetch((call) => {
    if (call.url === 'http://srv/v1/cloud/attachments/initiate') {
      return jsonResponse(200, {
        attachmentId: 'att_1',
        objectKey: 'attachments/acct/att_1',
        uploadUrl: 'https://s3.test/upload-att-1',
        expiresAt: '2026-05-12T00:15:00Z',
      });
    }
    if (call.url === 'http://srv/v1/cloud/attachments/att_1/upload') {
      return jsonResponse(200, {
        attachmentId: 'att_1',
        objectKey: 'attachments/acct/att_1',
        sizeBytes: 4,
        contentType: 'text/plain',
        sha256Hex: null,
        finalizedAt: '2026-05-12T00:01:00Z',
      });
    }
    throw new Error(`unexpected ${call.url}`);
  });
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  const uploaded = await client.uploadAttachment('kordi_cs_xyz', new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'text/plain' }));

  assert.equal(uploaded.attachmentId, 'att_1');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init?.method, 'POST');
  assert.equal(calls[1].init?.method, 'PUT');
  assert.equal(calls[1].url, 'http://srv/v1/cloud/attachments/att_1/upload');
  const headers = calls[1].init?.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer kordi_cs_xyz');
  assert.equal(headers['content-type'], 'text/plain');
});

test('downloadAttachmentContent fetches bytes through authenticated cloud API', async () => {
  const { calls, fetchImpl } = recordingFetch((call) => {
    assert.equal(call.url, 'http://srv/v1/cloud/attachments/att_1/content');
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    });
  });
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  const blob = await client.downloadAttachmentContent('kordi_cs_xyz', 'att_1');

  assert.equal(blob.type, 'image/png');
  assert.deepEqual(Array.from(new Uint8Array(await blob.arrayBuffer())), [1, 2, 3]);
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer kordi_cs_xyz');
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

test('markSessionMessagesRead posts session id to cloud session read route', async () => {
  const { calls, fetchImpl } = recordingFetch(() => new Response(null, { status: 204 }));
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  await client.markSessionMessagesRead('kordi_cs_xyz', 'session:group:one');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://srv/v1/cloud/sessions/session%3Agroup%3Aone/read');
  assert.equal(calls[0].init?.method, 'POST');
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer kordi_cs_xyz');
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
  const avatarUrl = 'data:image/jpeg;base64,profile';
  const { calls, fetchImpl } = recordingFetch(() => jsonResponse(200, {
    accountId: 'acct_1',
    displayName: 'Grace',
    primaryEmail: 'grace@example.com',
    avatarUrl,
    nodeId: null,
    passwordSet: false,
  }));
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  const account = await client.updateProfile('kordi_cs_xyz', {
    displayName: 'Grace',
    avatarUrl,
  });

  assert.equal(account.displayName, 'Grace');
  assert.equal(account.avatarUrl, avatarUrl);
  assert.equal(calls[0].url, 'http://srv/v1/cloud/auth/me');
  assert.equal(calls[0].init?.method, 'PATCH');
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer kordi_cs_xyz');
  assert.deepEqual(JSON.parse(calls[0].init?.body as string), {
    displayName: 'Grace',
    avatarUrl,
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
