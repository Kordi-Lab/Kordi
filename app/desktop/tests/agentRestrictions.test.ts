import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  agentRestrictedAccountIds,
  isAgentUnavailableRefusal,
  noteAgentAccess,
  resetAgentRestrictionsForTests,
} from '../src/features/cloud/agentRestrictions';
import { CloudAuthError } from '../src/features/cloud/cloudAuthError';
import { fetchRestrictedPeople } from '../src/features/cloud/contactPermissionsClient';
import { cloudGroupNativeContextMessages } from '../src/features/cloud/cloudGroupAgentPolicy';
import { buildCloudMessageIndex } from '../src/features/cloud/cloudMessageIndex';
import { encodeCloudGroupControl } from '../src/features/cloud/cloudGroupMessages';
import type { CloudMessage } from '../src/features/cloud/authClient';

const token = async () => 'token';
const people = [
  { accountId: 'acct_riya', agentAccess: false, cardAccess: true, updatedAt: null },
  { accountId: 'acct_sam', agentAccess: true, cardAccess: false, updatedAt: null },
];

test('the restricted list reads only people without agent access and is cached briefly', async () => {
  resetAgentRestrictionsForTests();
  let calls = 0;
  const request = async <T,>(path: string) => {
    calls += 1;
    assert.equal(path, '/v1/cloud/contacts/permissions');
    return { people } as T;
  };
  let now = 1_000;
  const ids = await agentRestrictedAccountIds({ token, request }, () => now);
  assert.deepEqual([...ids], ['acct_riya']);
  now += 5_000;
  await agentRestrictedAccountIds({ token, request }, () => now);
  assert.equal(calls, 1, 'a fresh list is reused');
  now += 20_000;
  await agentRestrictedAccountIds({ token, request }, () => now);
  assert.equal(calls, 2, 'a stale list is read again');
});

test('a server without the route restricts nobody; a failed refresh keeps the last list', async () => {
  resetAgentRestrictionsForTests();
  const missing = async <T,>(): Promise<T> => { throw new CloudAuthError('not_found' as never, 'Not found', 404); };
  assert.equal((await agentRestrictedAccountIds({ token, request: missing })).size, 0);
  resetAgentRestrictionsForTests();
  let now = 0;
  const ok = async <T,>() => ({ people } as T);
  await agentRestrictedAccountIds({ token, request: ok }, () => now);
  now = 60_000;
  const offline = async <T,>(): Promise<T> => { throw new CloudAuthError('network_error', 'Offline', 0); };
  assert.deepEqual([...await agentRestrictedAccountIds({ token, request: offline }, () => now)], ['acct_riya']);
});

test('a saved switch applies at once', async () => {
  resetAgentRestrictionsForTests();
  const request = async <T,>() => ({ people: [] } as T);
  let now = 0;
  await agentRestrictedAccountIds({ token, request }, () => now);
  noteAgentAccess('acct_riya', false);
  now = 1;
  assert.ok((await agentRestrictedAccountIds({ token, request }, () => now)).has('acct_riya'));
  noteAgentAccess('acct_riya', true);
  assert.ok(!(await agentRestrictedAccountIds({ token, request }, () => now)).has('acct_riya'));
});

test('the list parser keeps rows with an account id', async () => {
  const request = async <T,>() => ({ people: [...people, { agentAccess: false }] } as T);
  assert.deepEqual((await fetchRestrictedPeople({ token, request })).map((p) => p.accountId), ['acct_riya', 'acct_sam']);
});

test('only the generic 403 counts as the restriction refusal', () => {
  assert.ok(isAgentUnavailableRefusal(new CloudAuthError('agent_not_available', 'This agent isn\'t available.', 403)));
  assert.ok(!isAgentUnavailableRefusal(new CloudAuthError('agent_not_available', 'Busy', 409)));
  assert.ok(!isAgentUnavailableRefusal(new Error('agent_not_available')));
});

const wire = (id: string, body: string, sequence: number): CloudMessage => ({
  messageId: id, fromAccountId: 'acct_owner', toAccountId: 'peer', direction: 'outgoing',
  body, sessionId: 'chat', conversationSequence: sequence, createdAt: new Date(sequence * 1000).toISOString(),
  deliveredAt: null, readAt: null,
});

test('group context leaves out messages from people the owner restricted', () => {
  const participants = ['acct_owner', 'acct_riya', 'acct_sam'].map((accountId) => ({ accountId, displayName: accountId, role: 'person' }));
  const rows = [
    { id: 'riya-note', text: 'RESTRICTED_TEXT', createdAtMs: 1000, senderAccountId: 'acct_riya' },
    { id: 'sam-note', text: 'Sam context', createdAtMs: 2000, senderAccountId: 'acct_sam' },
    { id: 'request', text: 'Summarize', createdAtMs: 3000, senderAccountId: 'acct_sam' },
  ].map((message, index) => wire(message.id, encodeCloudGroupControl({
    kind: 'group-message', groupId: 'session:group:chat', groupSpaceId: 'session:group:space', groupTitle: null,
    createdByAccountId: 'acct_owner', actor: { accountId: message.senderAccountId, displayName: message.senderAccountId, role: 'person' },
    participants,
    message: { ...message, senderKind: 'human' },
  }), index + 1));
  const groupRows = buildCloudMessageIndex('acct_owner', { peer: rows }).groupRows;
  const context = (excluded?: ReadonlySet<string>) => cloudGroupNativeContextMessages({
    groupRows, groupId: 'session:group:chat', requestMessageId: 'request', requestCreatedAtMs: 3000,
    respondingAccountId: 'acct_owner', excludedSenderAccountIds: excluded,
  }).filter((row) => row.id.endsWith('-note')).map((row) => row.id);
  assert.deepEqual(context(), ['riya-note', 'sam-note']);
  assert.deepEqual(context(new Set(['acct_riya'])), ['sam-note']);
});

test('the Mac answers nothing in the group when the server gives the restriction refusal', async () => {
  const { handleCloudGroupAgentFailure } = await import('../src/features/cloud/cloudGroupAgentFailure');
  const removed: string[] = [];
  let stateUpdates = 0;
  const failures: unknown[] = [];
  await handleCloudGroupAgentFailure(
    new CloudAuthError('agent_not_available', 'This agent isn\'t available.', 403),
    {
      context: { account: { accountId: 'acct_owner' }, envelope: { groupId: 'session:group:chat', message: { id: 'request' } } } as never,
      setCanonicalState: ((update: (current: null) => unknown) => { stateUpdates += 1; update(null); }) as never,
      runtime: { turnIdsByRequestId: new Map([['request', 'turn']]), reportFailure: (_: string, error: unknown) => failures.push(error) } as never,
      stateOps: {
        cleanText: (value?: string | null) => value?.trim() ?? '',
        removePendingRows: (_current: unknown, requestId: string) => { removed.push(requestId); return null; },
        removeTimeoutPlaceholder: () => null,
      },
    },
  );
  assert.equal(stateUpdates, 1);
  assert.deepEqual(removed, ['request'], 'the pending reply is cleared');
  assert.deepEqual(failures, [], 'nothing is reported or published');
});
