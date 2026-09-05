import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CloudAuthClient,
  CloudAuthError,
  parseCloudOAuthHashResult,
} from '../src/features/cloud/authClient';

type FetchCall = { url: string; init: RequestInit | undefined };

const testDevice = {
  displayName: 'Ada’s Mac',
  platform: 'macos',
  osVersion: '15.6',
  appVersion: '0.0.1-beta.12',
  approximateLocation: 'Riyadh, Saudi Arabia',
  publicKey: 'test-public-key',
  keyAlgorithm: 'p256' as const,
};

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


test('signup surfaces an invalid canonical avatar seed', async () => {
  const { fetchImpl } = recordingFetch(() =>
    jsonResponse(400, { errorCode: 'invalid_avatar_seed', message: 'Generated avatar seed is invalid.' }),
  );
  const client = new CloudAuthClient({
    baseUrl: 'http://srv',
    fetchImpl,
    deviceRegistration: async () => testDevice,
  });

  await assert.rejects(
    () => client.signup({ email: 'a@b.com', password: 'correct horse', avatarSeed: ':' }),
    (caught: unknown) => {
      assert.ok(caught instanceof CloudAuthError);
      assert.equal((caught as CloudAuthError).code, 'invalid_avatar_seed');
      assert.equal((caught as CloudAuthError).status, 400);
      return true;
    },
  );
});

test('signup throws CloudAuthError with the server-supplied error code on 409', async () => {
  const { fetchImpl } = recordingFetch(() =>
    jsonResponse(409, { errorCode: 'email_in_use', message: 'Already in use.' }),
  );
  const client = new CloudAuthClient({
    baseUrl: 'http://srv',
    fetchImpl,
    deviceRegistration: async () => testDevice,
  });

  await assert.rejects(
    () => client.signup({ email: 'a@b.com', password: 'correct horse', avatarSeed: 'signup_seed' }),
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

test('capabilities keeps hosted OAuth available for product deployments', async () => {
  const { fetchImpl } = recordingFetch(() => jsonResponse(404, {
    message: 'Not Found',
  }));
  const client = new CloudAuthClient({
    baseUrl: 'https://kordi.ai',
    fetchImpl,
  });

  assert.deepEqual(await client.capabilities(), {
    password: true,
    oauthProviders: ['google', 'github'],
  });
});

test('capabilities does not infer providers for non-product servers', async () => {
  const { fetchImpl } = recordingFetch(() => jsonResponse(404, {
    message: 'Not Found',
  }));
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  await assert.rejects(
    () => client.capabilities(),
    (caught: unknown) => {
      assert.ok(caught instanceof CloudAuthError);
      assert.equal((caught as CloudAuthError).status, 404);
      return true;
    },
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

test('listSessionVisibility loads account-scoped chat list state', async () => {
  const { calls, fetchImpl } = recordingFetch(() => jsonResponse(200, {
    hiddenSessionIds: ['session:hidden'],
    deletedSessionIds: ['session:deleted'],
    unreadSessionIds: ['session:unread'],
    pinnedSessionIds: ['session:pinned'],
    mutedSessionIds: ['session:muted'],
    pinnedGroupSpaceIds: ['session:group:mobile'],
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
    unreadSessionIds: ['session:unread'],
    pinnedSessionIds: ['session:pinned'],
    mutedSessionIds: ['session:muted'],
    pinnedGroupSpaceIds: ['session:group:mobile'],
  });
});

test('chat list preference methods use the account and group routes', async () => {
  const { calls, fetchImpl } = recordingFetch(() => new Response(null, { status: 204 }));
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  await client.setCloudSessionPinned('kordi_cs_xyz', 'session:one', true);
  await client.setCloudSessionMuted('kordi_cs_xyz', 'session:one', false);
  await client.setCloudSessionUnread('kordi_cs_xyz', 'session:one', true);
  await client.setCloudGroupSpacePinned('kordi_cs_xyz', 'session:group:mobile', true);
  await client.setCloudGroupSpaceMuted('kordi_cs_xyz', 'session:group:mobile', false);
  await client.setCloudGroupSpaceArchived('kordi_cs_xyz', 'session:group:mobile', true);

  assert.equal(calls[0].url, 'http://srv/v1/cloud/sessions/session%3Aone/pinned');
  assert.equal(calls[0].init?.method, 'PUT');
  assert.equal(calls[1].url, 'http://srv/v1/cloud/sessions/session%3Aone/muted');
  assert.equal(calls[1].init?.method, 'DELETE');
  assert.equal(calls[2].url, 'http://srv/v1/cloud/sessions/session%3Aone/unread');
  assert.equal(calls[2].init?.method, 'PUT');
  assert.equal(calls[3].url, 'http://srv/v1/cloud/group-spaces/session%3Agroup%3Amobile/pinned');
  assert.equal(calls[3].init?.method, 'PUT');
  assert.equal(calls[4].url, 'http://srv/v1/cloud/group-spaces/session%3Agroup%3Amobile/muted');
  assert.equal(calls[4].init?.method, 'DELETE');
  assert.equal(calls[5].url, 'http://srv/v1/cloud/group-spaces/session%3Agroup%3Amobile/hidden');
  assert.equal(calls[5].init?.method, 'PUT');
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

test('Chat v2 nested errors preserve the server message', async () => {
  const { fetchImpl } = recordingFetch(() =>
    jsonResponse(409, {
      error: {
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'The Support session has an incompatible legacy shape.',
      },
    }),
  );
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  await assert.rejects(
    () => client.bootstrapChatSync('kordi_cs_abc'),
    (caught: unknown) => {
      assert.ok(caught instanceof CloudAuthError);
      assert.equal((caught as CloudAuthError).code, 'unknown');
      assert.equal(
        (caught as CloudAuthError).message,
        'The Support session has an incompatible legacy shape.',
      );
      return true;
    },
  );
});
