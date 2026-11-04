import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CloudAuthClient } from '../src/features/cloud/authClient';
import { conversation, message } from './helpers/chatSyncCanonicalFixtures';

test('channel creation uses existing group authorization before sending its notice', async () => {
  const calls: string[] = [];
  const group = { ...conversation, kind: 'group', group_space_id: 'existing-group', legacy_session_id: 'session:group:new' };
  const client = new CloudAuthClient({ baseUrl: 'https://cloud.test', fetchImpl: async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/channels')) return new Response(JSON.stringify({ conversation: group }), { status: 201 });
    if (url.endsWith('/messages')) return new Response(JSON.stringify({ message: { ...message, conversation_id: group.id } }), { status: 201 });
    throw new Error('Unexpected request');
  } });
  await client.sendMessage('synthetic-token', 'acct_a', 'Channel created', {
    sessionId: group.legacy_session_id, conversationKind: 'group', memberAccountIds: ['acct_a'],
    sourceGroupSpaceId: 'existing-group', sharedTitle: 'Synthetic channel',
  });
  assert.equal(calls[0], 'https://cloud.test/v2/chat/group-spaces/existing-group/channels');
  assert.ok(calls[1].endsWith('/messages'));
});

test('forbidden channel creation never posts a notice or falls back to an unrelated group', async () => {
  const calls: string[] = [];
  const client = new CloudAuthClient({ baseUrl: 'https://cloud.test', fetchImpl: async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ message: 'Forbidden' }), { status: 403 });
  } });
  await assert.rejects(client.sendMessage('synthetic-token', 'acct_a', 'Channel created', {
    sessionId: 'session:group:denied', conversationKind: 'group', memberAccountIds: ['acct_a'],
    sourceGroupSpaceId: 'existing-group', sharedTitle: 'Synthetic channel',
  }));
  assert.deepEqual(calls, ['https://cloud.test/v2/chat/group-spaces/existing-group/channels']);
});

test('older servers retain the existing contact-authorized creation path', async () => {
  const calls: string[] = [];
  const client = new CloudAuthClient({ baseUrl: 'https://cloud.test', fetchImpl: async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/channels')) return new Response('', { status: 404 });
    if (url.endsWith('/conversations')) return new Response(JSON.stringify({ conversation: { ...conversation, kind: 'group' } }), { status: 201 });
    return new Response(JSON.stringify({ message }), { status: 201 });
  } });
  await client.sendMessage('synthetic-token', 'acct_a', 'Channel created', {
    sessionId: 'session:group:legacy', conversationKind: 'group', memberAccountIds: ['acct_a'], sourceGroupSpaceId: 'existing-group', sharedTitle: 'Synthetic channel',
  });
  assert.deepEqual(calls.slice(0, 2), ['https://cloud.test/v2/chat/group-spaces/existing-group/channels', 'https://cloud.test/v2/chat/conversations']);
});
