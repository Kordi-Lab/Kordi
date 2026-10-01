import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CloudAuthClient, CloudAuthError } from '../src/features/cloud/authClient';
import { buildCloudAuthError } from '../src/features/cloud/cloudAuthError';
import {
  blockAccount,
  createReport,
  isMissingRoute,
  leaveConversation,
  listBlockedAccounts,
  removeContact,
  resolveCloudConversationId,
  unblockAccount,
  withdrawContactRequest,
} from '../src/features/safety/safetyClient';

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function recordingClient(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : null,
    };
    calls.push(call);
    return respond(call);
  };
  return { client: new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl }), calls };
}

const block = {
  accountId: 'acct_b',
  kordiId: '482731906',
  displayName: 'Bea',
  avatarUrl: null,
  blockedAt: '2026-10-01T00:00:00Z',
};

test('contact and block calls use the documented paths, methods, and bearer token', async () => {
  const { client, calls } = recordingClient((call) => {
    if (call.method === 'GET') return Response.json({ blocks: [block] });
    if (call.method === 'PUT') return Response.json({ block, removedContact: true });
    return new Response(null, { status: 204 });
  });

  await removeContact(client, 'tok', 'acct_b');
  await withdrawContactRequest(client, 'tok', 'req_1');
  assert.deepEqual(await listBlockedAccounts(client, 'tok'), [block]);
  assert.deepEqual(await blockAccount(client, 'tok', 'acct_b'), { block, removedContact: true });
  await unblockAccount(client, 'tok', 'acct_b');

  assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), [
    'DELETE http://srv/v1/cloud/contacts/acct_b',
    'POST http://srv/v1/cloud/contacts/requests/req_1/withdraw',
    'GET http://srv/v1/cloud/blocks',
    'PUT http://srv/v1/cloud/blocks/acct_b',
    'DELETE http://srv/v1/cloud/blocks/acct_b',
  ]);
  assert.ok(calls.every((call) => call.headers.authorization === 'Bearer tok'));
});

test('reports send only ids and choices, and return the receipt', async () => {
  const receipt = {
    reportId: 'rpt_0123456789abcdef0123456789abcdef',
    reference: 'R-01234567',
    status: 'received',
    reason: 'spam',
    targetKind: 'message',
    evidenceMessageCount: 1,
    reportedDisplayName: 'Bea',
    createdAt: '2026-10-01T00:00:00Z',
    closedAt: null,
  };
  const { client, calls } = recordingClient(() => Response.json({ report: receipt }, { status: 201 }));
  const input = {
    clientReportId: '00000000-0000-4000-8000-000000000001',
    reason: 'spam' as const,
    conversationId: '00000000-0000-4000-8000-000000000002',
    messageIds: ['00000000-0000-4000-8000-000000000003'],
    reportedAccountId: 'acct_b',
  };

  assert.deepEqual(await createReport(client, 'tok', input), receipt);
  assert.equal(calls[0]?.url, 'http://srv/v1/cloud/reports');
  assert.equal(calls[0]?.method, 'POST');
  assert.equal(calls[0]?.headers['content-type'], 'application/json');
  assert.deepEqual(calls[0]?.body, input);
});

test('leaving sends a fresh operation id per action and the successor hint', async () => {
  const { client, calls } = recordingClient(() => Response.json({
    left_conversation_ids: ['00000000-0000-4000-8000-00000000000a'],
    successor_account_id: 'acct_c',
  }));

  const first = await leaveConversation(client, 'tok', '00000000-0000-4000-8000-00000000000a', 'acct_c');
  await leaveConversation(client, 'tok', '00000000-0000-4000-8000-00000000000a', null);

  assert.deepEqual(first, {
    leftConversationIds: ['00000000-0000-4000-8000-00000000000a'],
    successorAccountId: 'acct_c',
  });
  assert.equal(calls[0]?.url, 'http://srv/v2/chat/conversations/00000000-0000-4000-8000-00000000000a/leave');
  const [one, two] = calls.map((call) => call.body as { client_operation_id: string; successor_account_id: string | null });
  assert.equal(one?.successor_account_id, 'acct_c');
  assert.equal(two?.successor_account_id, null);
  assert.match(one?.client_operation_id ?? '', /^[0-9a-f-]{36}$/);
  assert.notEqual(one?.client_operation_id, two?.client_operation_id);
});

test('only an empty 404 counts as a server without the route', () => {
  assert.equal(isMissingRoute(buildCloudAuthError(404, null, 'missing')), true);
  assert.equal(isMissingRoute(buildCloudAuthError(404, { error: { code: 'CHAT_ENTITY_NOT_FOUND', message: 'x' } }, 'x')), false);
  assert.equal(isMissingRoute(buildCloudAuthError(404, { errorCode: 'not_found', message: 'x' }, 'x')), false);
  assert.equal(isMissingRoute(buildCloudAuthError(404, { errorCode: 'account_missing', message: 'x' }, 'x')), false);
  assert.equal(isMissingRoute(buildCloudAuthError(403, { error: { code: 'CHAT_RELATIONSHIP_REQUIRED', message: 'x' } }, 'x')), false);
  assert.equal(isMissingRoute(new CloudAuthError('network_error', 'offline', 0)), false);
  assert.equal(isMissingRoute(new Error('plain')), false);
});

test('new server error codes keep their code instead of becoming unknown', () => {
  for (const code of [
    'contact_request_unavailable', 'blocked_account', 'self_block', 'cannot_block_service',
    'invalid_report', 'invalid_report_evidence', 'self_report', 'report_conflict',
    'report_too_large', 'request_decided', 'already_contact', 'not_found',
  ]) {
    assert.equal(buildCloudAuthError(400, { errorCode: code, message: 'm' }, 'f').code, code);
  }
  for (const code of ['CHAT_RELATIONSHIP_REQUIRED', 'CHAT_ENTITY_NOT_FOUND', 'CHAT_FORBIDDEN']) {
    assert.equal(buildCloudAuthError(403, { error: { code, message: 'm' } }, 'f').code, code);
  }
});

test('report conversations resolve a session id through the chat bootstrap', async () => {
  const conversationId = '00000000-0000-4000-8000-0000000000aa';
  const { client, calls } = recordingClient(() => Response.json({
    protocol_version: 2,
    conversations: [{
      id: conversationId,
      kind: 'direct',
      shared_title: null,
      version: 1,
      created_by_account_id: 'acct_a',
      legacy_session_id: 'session:direct-person:acct_a:acct_b',
      latest_message_sequence: 1,
      created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-01T00:00:00Z',
      members: [],
      preferences: { account_id: 'acct_a', version: 1, personal_title: null },
    }],
    latest_messages: [],
  }));

  assert.equal(await resolveCloudConversationId(client, 'tok', conversationId), conversationId);
  assert.equal(calls.length, 0, 'a cloud id needs no lookup');
  assert.equal(
    await resolveCloudConversationId(client, 'tok', 'session:direct-person:acct_a:acct_b'),
    conversationId,
  );
  assert.equal(await resolveCloudConversationId(client, 'tok', 'session:unknown'), null);
});
