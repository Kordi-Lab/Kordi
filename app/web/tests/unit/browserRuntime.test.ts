import assert from 'node:assert/strict';
import test from 'node:test';
import { applyBrowserCanonicalCommand } from '@web/runtime/browserCanonicalCommands';
import { browserCanonicalCatalog, browserCanonicalPage, emptyBrowserCanonicalState, openBrowserCanonicalSession,
  upsertBrowserMessage } from '@web/runtime/browserCanonicalProjection';
import { browserCanonicalScope } from '@web/runtime/browserCanonicalStorage';
import { applyBrowserChatSyncBatch, applyBrowserChatSyncCommand, runBrowserChatSyncCommand, emptyBrowserChatSync } from '@web/runtime/browserChatSync';
import { browserAttachmentBlob, clearBrowserAttachments, runBrowserAttachmentCommand, storeBrowserAttachment } from '@web/runtime/browserAttachments';
import type { ChatSyncConversation, ChatSyncMessage } from '@/features/cloud/chatSyncTypes';

function canonical() {
  const state = emptyBrowserCanonicalState('owner', 100);
  openBrowserCanonicalSession(state, { id: 'chat', kind: 'group', createdByIdentityId: 'human:owner',
    participantIdentityIds: ['human:peer'], title: 'Team' }, 100);
  return state;
}
function append(state: ReturnType<typeof canonical>, id: string, createdAtMs: number) {
  return upsertBrowserMessage(state, { id, sessionId: 'chat', senderIdentityId: 'human:peer', senderRole: 'person',
    messageKind: 'text', contentText: id, createdAtMs, sourceTransport: 'cloud-group', sourceEventId: `cloud-group:${id}` }, 200);
}
const conversation: ChatSyncConversation = {
  id: 'wire-chat', kind: 'group', shared_title: 'Team', version: 1, created_by_account_id: 'owner',
  legacy_session_id: 'chat', latest_message_sequence: 3, created_at: '2026-01-01', updated_at: '2026-01-01', members: [],
  preferences: { conversation_id: 'wire-chat', account_id: 'owner', personal_title: null, version: 1 },
};
function wire(id: string, sequence: number, version = 1): ChatSyncMessage {
  return { id, client_message_id: `client-${id}`, conversation_id: conversation.id, conversation_sequence: sequence,
    sender_account_id: 'peer', kind: 'text', content: { text: id }, reply_to_message_id: null, attachment_ids: [],
    version, generation_status: null, provider_response_id: null, created_at: '2026-01-01', edited_at: null, deleted_at: null };
}

test('canonical scopes distinguish account and organization without ambiguous separators', () => {
  assert.notEqual(browserCanonicalScope('a:b', 'c'), browserCanonicalScope('a', 'b:c'));
  assert.notEqual(browserCanonicalScope('owner'), browserCanonicalScope('owner', 'team'));
  assert.notEqual(browserCanonicalScope('owner', 'team'), browserCanonicalScope('peer', 'team'));
});

test('browser projection starts without fabricated conversations or an agent', () => {
  const state = emptyBrowserCanonicalState('owner', 10);
  assert.equal(state.profile.humanIdentityId, 'human:owner');
  assert.equal(state.sessions.length, 0);
  assert.equal(state.profile.activeAgentIdentityId, undefined);
});

test('replayed canonical messages retain identity and sequence while content updates', () => {
  const state = canonical();
  const first = append(state, 'one', 110);
  const updated = upsertBrowserMessage(state, { ...first, contentText: 'edited', status: 'read' }, 300);
  assert.equal(state.messages.length, 1);
  assert.equal(updated.sequenceNum, first.sequenceNum);
  assert.equal(updated.createdAtMs, 110);
  assert.equal(updated.status, 'read');
  assert.equal(updated.contentText, 'edited');
  assert.equal(browserCanonicalCatalog(state).summaries[0].messageCount, 1);
});

test('timeline pages follow chronology even when older history arrives after the newest message', () => {
  const state = canonical();
  append(state, 'new', 300); append(state, 'old', 100); append(state, 'middle', 200);
  const latest = browserCanonicalPage(state, { sessionId: 'chat', limit: 2, timelineOrder: true });
  assert.deepEqual(latest.messages.map(row => row.id), ['middle', 'new']);
  assert.equal(latest.hasOlder, true);
  const older = browserCanonicalPage(state, { sessionId: 'chat', limit: 2, timelineOrder: true, beforeTimeline: latest.messages[0] });
  assert.deepEqual(older.messages.map(row => row.id), ['old']);
  assert.equal(older.hasOlder, false);
});

test('unknown native commands and moving messages between conversations fail explicitly', () => {
  const state = canonical();
  append(state, 'one', 110);
  openBrowserCanonicalSession(state, { id: 'other', kind: 'group', createdByIdentityId: 'human:owner', participantIdentityIds: [] });
  assert.throws(() => upsertBrowserMessage(state, { ...state.messages[0], sessionId: 'other' }), /cannot move/);
  assert.throws(() => applyBrowserCanonicalCommand(state, 'desktop_canonical_unimplemented'), /desktop app/);
});

test('cloud deletion removes the mirrored row, leaving unrelated local messages intact', () => {
  const state = canonical(); append(state, 'one', 100); append(state, 'two', 200);
  assert.deepEqual(applyBrowserCanonicalCommand(state, 'desktop_canonical_delete_cloud_message', { cloudMessageId: 'one' }), ['one']);
  assert.deepEqual(state.messages.map(row => row.id), ['two']);
});

test('local read cursors never move backwards', () => {
  const state = canonical(); append(state, 'one', 100); append(state, 'two', 200);
  applyBrowserCanonicalCommand(state, 'desktop_canonical_mark_session_read', { request: { sessionId: 'chat', messageId: 'two' } }, 300);
  applyBrowserCanonicalCommand(state, 'desktop_canonical_mark_session_read', { request: { sessionId: 'chat', messageId: 'one' } }, 400);
  assert.equal(state.participants.find(row => row.identityId === 'human:owner')?.lastReadMessageId, 'two');
});

test('wire sync persists monotonic cursors and rejects stale message versions', () => {
  const state = emptyBrowserChatSync('owner');
  applyBrowserChatSyncBatch(state, { accountId: 'owner', bootstrap: true, cursor: 'cursor-5', lastStreamSeq: 5,
    conversations: [conversation], messages: [wire('one', 1, 2)] });
  applyBrowserChatSyncBatch(state, { accountId: 'owner', bootstrap: false, cursor: 'cursor-3', lastStreamSeq: 3,
    messages: [wire('one', 1, 1)] });
  assert.equal(state.cursor, 'cursor-5'); assert.equal(state.lastStreamSeq, 5);
  assert.equal(state.messages[0].version, 2);
});

test('wire message tombstones prevent delayed sync from resurrecting deleted content', () => {
  const state = emptyBrowserChatSync('owner');
  applyBrowserChatSyncBatch(state, { accountId: 'owner', bootstrap: true, conversations: [conversation], messages: [wire('one', 1)] });
  applyBrowserChatSyncBatch(state, { accountId: 'owner', bootstrap: false, messages: [{ ...wire('one', 1, 2), deleted_at: '2026-01-02' }] });
  applyBrowserChatSyncBatch(state, { accountId: 'owner', bootstrap: false, messages: [wire('one', 1)] });
  assert.equal(state.messages.length, 0); assert.deepEqual(state.deletedMessageIds, ['one']);
});

test('bootstrap removes inaccessible conversations and their cached messages', () => {
  const state = emptyBrowserChatSync('owner');
  applyBrowserChatSyncBatch(state, { accountId: 'owner', bootstrap: true, conversations: [conversation], messages: [wire('one', 1)] });
  applyBrowserChatSyncBatch(state, { accountId: 'owner', bootstrap: true, conversations: [], messages: [] });
  assert.equal(state.conversations.length, 0); assert.equal(state.messages.length, 0);
});

test('membership removal and session deletion discard revoked wire history', () => {
  for (const [type, payload] of [['membership.removed', { account_id: 'owner' }], ['session.deleted', { sessionId: 'chat' }]] as const) {
    const state = emptyBrowserChatSync('owner');
    applyBrowserChatSyncBatch(state, { accountId: 'owner', bootstrap: true, conversations: [conversation], messages: [wire('one', 1)] });
    applyBrowserChatSyncBatch(state, { accountId: 'owner', bootstrap: false, events: [{ protocol_version: 2,
      stream_seq: 1, event_id: type, type, critical: true, conversation_id: conversation.id, entity_id: null,
      entity_version: null, occurred_at: '2026-01-02', payload }] });
    assert.equal(state.conversations.length, 0); assert.equal(state.messages.length, 0);
  }
});

test('outbox survives a retry and completes only after an explicit server success callback', () => {
  const state = emptyBrowserChatSync('owner');
  applyBrowserChatSyncCommand(state, 'desktop_chat_sync_outbox_enqueue', { request: { accountId: 'owner', operationId: 'send-1',
    payload: { peerAccountId: 'peer', body: 'Hello', options: {} } } }, 100);
  applyBrowserChatSyncCommand(state, 'desktop_chat_sync_outbox_fail', { request: { operationId: 'send-1', error: 'offline', retryable: true } }, 200);
  assert.equal(state.outbox.length, 1); assert.equal(state.outbox[0].attemptCount, 1);
  assert.deepEqual(applyBrowserChatSyncCommand(state, 'desktop_chat_sync_outbox_due', {}, 201), []);
  assert.equal((applyBrowserChatSyncCommand(state, 'desktop_chat_sync_outbox_due', {}, 5000) as unknown[]).length, 1);
  applyBrowserChatSyncCommand(state, 'desktop_chat_sync_outbox_complete', { operationId: 'send-1' });
  assert.equal(state.outbox.length, 0);
});

test('attachment blobs preserve MIME type and are revoked on sign out', async () => {
  const stored = storeBrowserAttachment(new Blob(['hello'], { type: 'text/plain' }), 'notes.txt');
  assert.equal(stored.mimeType, 'text/plain'); assert.equal(stored.sizeBytes, 5);
  assert.equal(await browserAttachmentBlob(stored.path).text(), 'hello');
  assert.deepEqual(await runBrowserAttachmentCommand('desktop_chat_read_attachment', { path: stored.path }), [104, 101, 108, 108, 111]);
  clearBrowserAttachments();
  assert.throws(() => browserAttachmentBlob(stored.path), /no longer available/);
});

test('attachment access never reads arbitrary filesystem paths or external URLs', async () => {
  await assert.rejects(runBrowserAttachmentCommand('desktop_chat_read_attachment', { path: 'file:///private/example' }), /no longer available/);
  await assert.rejects(runBrowserAttachmentCommand('desktop_chat_read_attachment', { path: 'https://example.com/private' }), /no longer available/);
});

test('unknown critical events fail before mutating content or advancing the durable cursor', () => {
  const state = emptyBrowserChatSync('owner');
  const before = structuredClone(state);
  assert.throws(() => applyBrowserChatSyncBatch(state, { accountId: 'owner', bootstrap: true,
    cursor: 'new-cursor', lastStreamSeq: 2, conversations: [conversation], messages: [wire('one', 1)],
    events: [{ protocol_version: 2, stream_seq: 2, event_id: 'future', type: 'future.private_change',
      critical: true, conversation_id: conversation.id, entity_id: null, entity_version: null,
      occurred_at: '2026-01-02', payload: {} }] }), /CLIENT_UPDATE_REQUIRED/);
  assert.deepEqual(state, before);
});

test('server cursor and preference events update browser membership monotonically', () => {
  const state = emptyBrowserChatSync('owner');
  const member = { account_id: 'owner', role: 'member', membership_state: 'active', version: 1,
    last_read_sequence: 2, last_delivered_sequence: 2, joined_at: '2026-01-01', left_at: null };
  applyBrowserChatSyncBatch(state, { accountId: 'owner', bootstrap: true,
    conversations: [{ ...conversation, members: [member] }] });
  for (const [type, payload] of [
    ['read_cursor.updated', { cursor: { account_id: 'owner', last_read_sequence: 3, last_delivered_sequence: 1 } }],
    ['conversation.preferences.updated', { preferences: { ...conversation.preferences, version: 2, personal_title: 'Renamed' } }],
  ] as const) applyBrowserChatSyncBatch(state, { accountId: 'owner', bootstrap: false, events: [{
    protocol_version: 2, stream_seq: 2, event_id: type, type, critical: true, conversation_id: conversation.id,
    entity_id: null, entity_version: null, occurred_at: '2026-01-02', payload }] });
  assert.equal(state.conversations[0].members[0].last_read_sequence, 3);
  assert.equal(state.conversations[0].members[0].last_delivered_sequence, 2);
  assert.equal(state.conversations[0].preferences.personal_title, 'Renamed');
  assert.equal(state.pinCacheReady, true);
});


test('a delayed history response cannot persist into a newly selected organization', async () => {
  let finishResponse!: () => void;
  let currentOrganization = 'old-team';
  const expectedOrganizationId = currentOrganization;
  const response = new Promise<void>(resolve => { finishResponse = resolve; });
  const pending = response.then(() => runBrowserChatSyncCommand('owner', currentOrganization,
    'desktop_chat_sync_apply', { request: { accountId: 'owner', expectedOrganizationId,
      bootstrap: false, conversations: [conversation], messages: [wire('private-old-team', 1)] } }));
  currentOrganization = 'new-team';
  finishResponse();
  // Rejection precedes opening IndexedDB, so no projection can receive the old response.
  await assert.rejects(pending, /organization changed/);
});

test('browser history writes require an explicit captured scope including the initial null scope', async () => {
  await assert.rejects(runBrowserChatSyncCommand('owner', 'team', 'desktop_chat_sync_apply',
    { request: { accountId: 'owner', bootstrap: false } }), /organization changed/);
  await assert.rejects(runBrowserChatSyncCommand('owner', 'team', 'desktop_chat_sync_apply',
    { request: { accountId: 'owner', expectedOrganizationId: null, bootstrap: false } }), /organization changed/);
});

test('manual browser renames use native title metadata and survive replayed automatic titles', () => {
  const state = canonical();
  state.sessions[0].metadata = { unrelated: 'kept', sessionTitleRevision: 2, sessionTitleUpdatedByAccountId: 'acct_old' };
  applyBrowserCanonicalCommand(state, 'desktop_canonical_rename_session', { request: { sessionId: 'chat', title: '  Hand edited  ' } }, 300);
  assert.equal(state.sessions[0].title, 'Hand edited');
  assert.equal(state.sessions[0].updatedAtMs, 300);
  assert.deepEqual(state.sessions[0].metadata, { unrelated: 'kept', titleSource: 'manual', sessionTitleSource: 'manual',
    sessionTitleRevision: 3, sessionTitlePolicyVersion: 1, sessionTitleUpdatedAtMs: 300 });
  openBrowserCanonicalSession(state, { id: 'chat', kind: 'group', createdByIdentityId: 'human:owner',
    participantIdentityIds: [], title: 'Automatic guess', metadata: { sessionTitleSource: 'auto', sessionTitleRevision: 4 } }, 400);
  assert.equal(state.sessions[0].title, 'Hand edited');
  assert.equal((state.sessions[0].metadata as { sessionTitleSource: string }).sessionTitleSource, 'manual');
  assert.throws(() => applyBrowserCanonicalCommand(state, 'desktop_canonical_rename_session', {
    request: { sessionId: 'chat', title: '  ' },
  }), /title is required/);
});
