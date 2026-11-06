import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CloudAuthClient, CloudAuthError } from '../src/features/cloud/authClient';
import { buildCloudAuthError } from '../src/features/cloud/cloudAuthError';
import { buildReportInput, nextReportAttempt, reportDialogTitle, REPORT_REASONS } from '../src/features/safety/reportReasons';
import { reportTargetForMessage } from '../src/features/safety/reportTarget';
import { createSafetyClient, isMissingRoute, type SafetyDeps } from '../src/features/safety/safetyClient';
import { safetyErrorMessage } from '../src/features/safety/safetyCopy';
import {
  __resetCloudBlocksForTests,
  cloudBlocksSnapshot,
  forgetBlockedAccount,
  refreshCloudBlocks,
  rememberBlockedAccount,
} from '../src/features/safety/useCloudBlocks';
import type { Message } from '../src/kordi-app/types';

const CONVERSATION_ID = '0b9f6c1e-3c1e-4b8a-9d55-1f2a3b4c5d6e';
const MESSAGE_ID = '7d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6';

function recordingClient(responses: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string | undefined }> = [];
  const fetchImpl: typeof fetch = (input, init) => {
    calls.push({
      url: input.toString(),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as string | undefined,
    });
    const next = responses.shift() ?? { status: 204 };
    return Promise.resolve(new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    }));
  };
  return { calls, auth: new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl }) };
}

const block = { accountId: 'acct_sam', kordiId: '100200300', displayName: 'Sam Rivera', avatarUrl: null, blockedAt: '2026-11-05T00:00:00Z' };

test('the client calls the block routes with the bearer token', async () => {
  const { calls, auth } = recordingClient([
    { status: 200, body: { blocks: [block] } },
    { status: 200, body: { block, removedContact: true } },
    { status: 204 },
  ]);
  const client = createSafetyClient(auth);

  assert.deepEqual(await client.listBlocks('tok'), [block]);
  assert.deepEqual(await client.block('tok', 'acct_sam'), { block, removedContact: true });
  await client.unblock('tok', 'acct_sam');

  assert.deepEqual(calls.map((call) => [call.method, call.url]), [
    ['GET', 'http://srv/v1/cloud/blocks'],
    ['PUT', 'http://srv/v1/cloud/blocks/acct_sam'],
    ['DELETE', 'http://srv/v1/cloud/blocks/acct_sam'],
  ]);
  assert.ok(calls.every((call) => call.headers.authorization === 'Bearer tok'));
  assert.equal(calls[1].body, '{}');
  assert.equal(calls[1].headers['content-type'], 'application/json');
});

test('the client posts reports and reads the also-block flag', async () => {
  const report = {
    reportId: 'rep_1', reference: 'R-ABCD1234', status: 'received', reason: 'spam', targetKind: 'message',
    evidenceMessageCount: 1, reportedDisplayName: 'Sam Rivera', createdAt: '2026-11-05T00:00:00Z', closedAt: null,
  };
  const { calls, auth } = recordingClient([{ status: 201, body: { report, blocked: true } }]);
  const input = { clientReportId: 'c1', reason: 'spam' as const, conversationId: CONVERSATION_ID, messageIds: [MESSAGE_ID], alsoBlock: true };
  const result = await createSafetyClient(auth).report('tok', input);

  assert.equal(result.report.reference, 'R-ABCD1234');
  assert.equal(result.blocked, true);
  assert.equal(calls[0].url, 'http://srv/v1/cloud/reports');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].body ?? ''), input);
});

test('server error codes reach the short copy; an empty 404 means an older server', async () => {
  const { auth } = recordingClient([
    { status: 400, body: { errorCode: 'self_block', message: 'Cannot block yourself.' } },
    { status: 404 },
  ]);
  const client = createSafetyClient(auth);
  const selfBlock = await client.block('tok', 'acct_me').catch((error: unknown) => error);
  assert.ok(selfBlock instanceof CloudAuthError);
  assert.equal(selfBlock.code, 'self_block');
  assert.equal(safetyErrorMessage(selfBlock, 'fallback'), "You can't block yourself.");
  assert.equal(isMissingRoute(selfBlock), false);

  const missing = await client.listBlocks('tok').catch((error: unknown) => error);
  assert.equal(isMissingRoute(missing), true);
  assert.equal(isMissingRoute(buildCloudAuthError(404, { errorCode: 'account_missing' }, 'x')), false);
  assert.equal(safetyErrorMessage(buildCloudAuthError(429, { errorCode: 'rate_limited' }, 'x'), 'fallback'), 'Too many reports. Try again later.');
  assert.equal(safetyErrorMessage(new Error('offline'), 'fallback'), 'fallback');
});

test('session ids resolve to the chat sync conversation id', async () => {
  const client = createSafetyClient({
    request: () => Promise.reject(new Error('unused')),
    bootstrapChatSync: () => Promise.resolve({ conversations: [{ id: CONVERSATION_ID, legacy_session_id: 'session-1' }] } as never),
  });
  assert.equal(await client.resolveConversationId('tok', CONVERSATION_ID), CONVERSATION_ID);
  assert.equal(await client.resolveConversationId('tok', 'session-1'), CONVERSATION_ID);
  assert.equal(await client.resolveConversationId('tok', 'session-unknown'), null);
});

test('report reasons and request bodies follow the approved copy and API', () => {
  assert.deepEqual(REPORT_REASONS.map((reason) => [reason.label, reason.value]), [
    ['Spam', 'spam'],
    ['Harassment or hate', 'harassment'],
    ['Sexual or violent content', 'inappropriate'],
    ['Something else', 'other'],
  ]);
  assert.equal(reportDialogTitle({ accountId: 'acct_sam', name: 'Sam Rivera' }), 'Report Sam Rivera');
  assert.equal(reportDialogTitle({ accountId: 'acct_sam', name: 'Sam Rivera', messageIds: [MESSAGE_ID] }), 'Report message');

  assert.deepEqual(buildReportInput({ accountId: 'acct_sam', name: 'Sam' }, 'spam', '  ', false, 'c1'), {
    clientReportId: 'c1', reason: 'spam', reportedAccountId: 'acct_sam',
  });
  assert.deepEqual(
    buildReportInput({ accountId: null, name: 'Sam', conversationId: CONVERSATION_ID, messageIds: [MESSAGE_ID, MESSAGE_ID] }, 'other', ' rude ', true, 'c2'),
    { clientReportId: 'c2', reason: 'other', details: 'rude', conversationId: CONVERSATION_ID, messageIds: [MESSAGE_ID], alsoBlock: true },
  );
});

test('a retry with the same choices reuses the client report id', () => {
  let counter = 0;
  const newId = () => `id-${++counter}`;
  const first = nextReportAttempt(null, 'a', newId);
  assert.equal(nextReportAttempt(first, 'a', newId), first);
  assert.equal(nextReportAttempt(first, 'b', newId).id, 'id-2');
});

function peerMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm1', role: 'person', sender: 'Sam Rivera', senderType: 'human', senderIdentityId: 'human:acct_sam',
    isOwnMessage: false, text: 'hello', time: '', reactionConversationId: CONVERSATION_ID, reactionTargetMessageId: MESSAGE_ID,
    ...overrides,
  };
}

test('only finished hosted messages from other people can be reported', () => {
  assert.deepEqual(reportTargetForMessage(peerMessage()), {
    accountId: 'acct_sam', name: 'Sam Rivera', conversationId: CONVERSATION_ID, messageIds: [MESSAGE_ID],
  });
  assert.deepEqual(reportTargetForMessage(peerMessage({ senderType: 'agent', role: 'external-agent', senderOwnerName: 'Sam Rivera', sender: 'Sam’s agent' })), {
    accountId: null, name: 'Sam Rivera', conversationId: CONVERSATION_ID, messageIds: [MESSAGE_ID],
  });
  assert.equal(reportTargetForMessage(peerMessage({ isOwnMessage: true, role: 'user' })), null);
  assert.equal(reportTargetForMessage(peerMessage({ role: 'owned-agent', senderType: 'agent' })), null);
  assert.equal(reportTargetForMessage(peerMessage({ reactionTargetMessageId: 'local-only' })), null);
  assert.equal(reportTargetForMessage(peerMessage({ senderIdentityId: 'human:acct_kordi_support' })), null);
  assert.equal(reportTargetForMessage(peerMessage({ senderIdentityId: 'agent:cloud:acct_kordi_pip', senderType: 'agent' })), null);
  assert.equal(reportTargetForMessage(peerMessage({ role: 'system' })), null);
});

test('the block store marks an older server unavailable and applies confirmed changes', async () => {
  __resetCloudBlocksForTests();
  const deps = (listBlocks: SafetyDeps['client']['listBlocks']): SafetyDeps => ({
    loadSession: async () => ({ token: 'tok', accountId: 'acct_me' }),
    client: {
      listBlocks,
      block: () => Promise.reject(new Error('unused')),
      unblock: () => Promise.reject(new Error('unused')),
      report: () => Promise.reject(new Error('unused')),
      resolveConversationId: () => Promise.resolve(null),
    },
  });
  await refreshCloudBlocks('acct_me', deps(() => Promise.reject(new CloudAuthError('unknown', 'Not found', 404))));
  assert.deepEqual(cloudBlocksSnapshot('acct_me'), { blocks: [], loaded: true, available: false, error: null });

  await refreshCloudBlocks('acct_me', deps(() => Promise.resolve([block])));
  assert.equal(cloudBlocksSnapshot('acct_me').available, true);
  rememberBlockedAccount('acct_me', { ...block, accountId: 'acct_kai', displayName: 'Kai' });
  assert.deepEqual(cloudBlocksSnapshot('acct_me').blocks.map((item) => item.accountId), ['acct_kai', 'acct_sam']);
  forgetBlockedAccount('acct_me', 'acct_sam');
  assert.deepEqual(cloudBlocksSnapshot('acct_me').blocks.map((item) => item.accountId), ['acct_kai']);

  await refreshCloudBlocks('acct_me', deps(() => Promise.reject(new Error('offline'))));
  assert.equal(cloudBlocksSnapshot('acct_me').error, 'offline');
  assert.equal(cloudBlocksSnapshot('acct_me').blocks.length, 1);
  __resetCloudBlocksForTests();
});
