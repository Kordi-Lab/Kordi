import { CloudMessageDeletions } from '../src/features/cloud/cloudMessageDeletions';
import { ChatSyncConversationClient } from '../src/features/cloud/chatSyncConversationClient';
import { filterDeletedCanonicalStore } from '../src/features/canonical/canonicalMessageDeletions';
import { createCanonicalStore } from '../src/features/canonical/canonicalStore';
import type { CanonicalSessionMessage } from '../src/kordi-app/types';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatSyncState } from '../src/features/cloud/chatSyncState';
import { ChatSyncSyncClient } from '../src/features/cloud/chatSyncSyncClient';
import { cloudMessageFromChatSync } from '../src/features/cloud/chatSyncMapping';
import { applyCloudSyncEventsToMessagesByPeer } from '../src/features/cloud/cloudDiffSyncMessages';
import { conversation, message } from './helpers/chatSyncCanonicalFixtures';
import type { ChatSyncEvent, ChatSyncSyncResponse, ChatSyncMessage } from '../src/features/cloud/chatSyncTypes';

function event(type: string, sequence: number, payload: Record<string, unknown>): ChatSyncEvent {
  return { stream_seq: sequence, event_id: `event-${sequence}`, protocol_version: 2,
    type, critical: false, conversation_id: conversation.id, entity_id: message.id,
    entity_version: 1, occurred_at: '2026-09-09T00:00:00Z', payload };
}
function response(events: ChatSyncEvent[]): ChatSyncSyncResponse {
  return { protocol_version: 2, events, next_cursor: `cursor-${events.at(-1)?.stream_seq}`,
    last_stream_seq: events.at(-1)?.stream_seq ?? 0, has_more: false,
    server_time: '2026-09-09T00:00:00Z' };
}

test('delete for me remains hidden after a subsequent reaction update', async () => {
  const responses = [
    response([event('message.hidden', 1, { message_id: message.id })]),
    response([event('reaction.updated', 2, { message: { ...message, version: 2 }, conversation })]),
  ];
  const state = new ChatSyncState(async <T>() => responses.shift() as T, () => 'acct_b', () => {}, () => null, new CloudMessageDeletions(async () => []));
  state.rememberConversation(conversation);
  state.messageById.set(message.id, message);
  const client = new ChatSyncSyncClient(state);
  let visible = { acct_a: [cloudMessageFromChatSync(message, conversation, 'acct_b')] };
  visible = applyCloudSyncEventsToMessagesByPeer('acct_b', visible, (await client.syncCloudEvents('test-token', 'start')).events) as typeof visible;
  assert.equal(Object.values(visible).flat().length, 0, 'deletion initially succeeds');
  visible = applyCloudSyncEventsToMessagesByPeer('acct_b', visible, (await client.syncCloudEvents('test-token', 'cursor-1')).events) as typeof visible;
  assert.equal(Object.values(visible).flat().length, 0, 'later reaction must not restore a hidden message');
});

test('history started before deletion must not publish the deleted message afterwards', async () => {
  let finishHistory!: (value: { messages: ChatSyncMessage[]; next_before_sequence: null; has_more: boolean }) => void;
  const history = new Promise<{ messages: ChatSyncMessage[]; next_before_sequence: null; has_more: boolean }>((resolve) => { finishHistory = resolve; });
  const state = new ChatSyncState(async <T>(path: string) => (
    path.includes('/messages?') ? await history : response([event('message.deleted', 1, { message: { ...message, version: 2, deleted_at: '2026-09-09T00:00:00Z' } })])
  ) as T, () => 'acct_b', () => {}, () => null, new CloudMessageDeletions(async () => []));
  state.rememberConversation(conversation);
  state.messageById.set(message.id, message);
  const client = new ChatSyncSyncClient(state);
  const pending = client.listChatConversationHistoryPage('test-token', conversation.id);
  await client.syncCloudEvents('test-token', 'start');
  finishHistory({ messages: [message], next_before_sequence: null, has_more: false });
  const page = await pending;
  assert.equal(page.messages.length, 0, 'late history must not restore a deleted message');
});

for (const forEveryone of [false, true]) {
  test(`confirmed deletion rejects stale history without waiting for its sync event (everyone=${forEveryone})`, async () => {
    const removals = new CloudMessageDeletions(async () => []);
    const state = new ChatSyncState(async <T>() => undefined as T, () => 'acct_b', () => {}, () => null, removals);
    state.rememberConversation(conversation);
    const client = new ChatSyncConversationClient(state);
    await client.deleteMessage('test-token', conversation.id, message.id, forEveryone);
    assert.deepEqual(state.retainMessages([message]), []);
    assert.equal(removals.ids('acct_a').has(message.id), false);
  });
}

test('failed deletion does not record a permanent removal', async () => {
  const removals = new CloudMessageDeletions(async () => []);
  const state = new ChatSyncState(async () => { throw new Error('Rejected deletion'); }, () => 'acct_b', () => {}, () => null, removals);
  state.rememberConversation(conversation);
  const client = new ChatSyncConversationClient(state);
  await assert.rejects(client.deleteMessage('test-token', conversation.id, message.id, true), /Rejected deletion/);
  assert.equal(state.retainMessages([message]).length, 1);
});

test('persisted removals load once and remain account scoped after a renderer restart', async () => {
  let loads = 0;
  const removals = new CloudMessageDeletions(async (accountId) => { loads++; return accountId === 'acct_b' ? [message.id] : []; });
  const state = new ChatSyncState(async <T>() => ({ messages: [message], next_before_sequence: null, has_more: false }) as T,
    () => 'acct_b', () => {}, () => null, removals);
  state.rememberConversation(conversation);
  const client = new ChatSyncSyncClient(state);
  assert.equal((await client.listChatConversationHistoryPage('test-token', conversation.id)).messages.length, 0);
  assert.equal((await client.listChatConversationHistoryPage('test-token', conversation.id)).messages.length, 0);
  assert.equal(loads, 1);
  const staleSnapshot = { acct_a: [cloudMessageFromChatSync(message, conversation, 'acct_b')] };
  assert.equal(removals.filter('acct_b', staleSnapshot).acct_a.length, 0);
  assert.equal(removals.filter('acct_a', staleSnapshot), staleSnapshot);
});

test('failed marker reads can retry and do not replace an in-flight confirmed deletion', async () => {
  let calls = 0;
  const removals = new CloudMessageDeletions(async () => { if (++calls === 1) throw new Error('Database unavailable'); return []; });
  await assert.rejects(removals.ready('acct_b'), /Database unavailable/);
  removals.remember('acct_b', [message.id]);
  await removals.ready('acct_b');
  assert.equal(removals.ids('acct_b').has(message.id), true);
});

test('a stale canonical page cannot restore a cloud message through its local alias', () => {
  const local: CanonicalSessionMessage = {
    id: 'local-alias', sessionId: 'session-1', senderIdentityId: null, senderRole: 'human',
    messageKind: 'text', contentText: 'Synthetic message',
    content: { cloudReactionTargetMessageId: message.id }, parentMessageId: null,
    delegatedExchangeId: null, status: 'complete', sequenceNum: 1,
    createdAtMs: 1, updatedAtMs: 1, contentHash: null,
    sourceTransport: 'cloud-group', sourceEventId: `cloud-group:${message.id}`,
  };
  const store = { ...createCanonicalStore(), messagesBySessionId: { 'session-1': [local] } };
  const filtered = filterDeletedCanonicalStore(store, new Set([message.id]));
  assert.deepEqual(filtered.messagesBySessionId['session-1'], []);
  assert.equal(filterDeletedCanonicalStore(filtered, new Set([message.id])), filtered);
  assert.equal(filterDeletedCanonicalStore(store, new Set(['unrelated'])), store);
});


test('a create and delete in the same sync page leave no reusable cached message', async () => {
  const removals = new CloudMessageDeletions(async () => []);
  const result = response([
    event('message.created', 1, { message, conversation }),
    event('message.deleted', 2, { message: { ...message, deleted_at: '2026-09-09T00:00:00Z', version: 2 } }),
  ]);
  const state = new ChatSyncState(async <T>() => result as T, () => 'acct_b', () => {}, () => null, removals);
  state.rememberConversation(conversation);
  const batch = await new ChatSyncSyncClient(state).syncCloudEvents('test-token', 'start');
  assert.equal(state.messageById.has(message.id), false);
  assert.equal(batch.chat?.messages.length, 0);
});

test('a filtered history page retains its pagination cursor', async () => {
  const removals = new CloudMessageDeletions(async () => [message.id]);
  const state = new ChatSyncState(async <T>() => ({ messages: [message], next_before_sequence: 8, has_more: true }) as T,
    () => 'acct_b', () => {}, () => null, removals);
  state.rememberConversation(conversation);
  const page = await new ChatSyncSyncClient(state).listChatConversationHistoryPage('test-token', conversation.id);
  assert.deepEqual(page, { messages: [], nextBeforeSequence: 8, hasMore: true });
});
