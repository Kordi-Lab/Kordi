import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CloudAuthClient,
  type ChatSyncConversation,
  type ChatSyncMessage,
} from '../src/features/cloud/authClient';
import { applyCloudSyncEventsToSessionPins } from '../src/features/cloud/cloudDiffSync';

const sessionId = 'session:direct-person:acct_a:acct_b';
const conversation: ChatSyncConversation = {
  id: '019cb111-8ecc-7181-8266-8986d950169b',
  kind: 'direct',
  shared_title: 'Synced title',
  version: 3,
  created_by_account_id: 'acct_a',
  legacy_session_id: sessionId,
  latest_message_sequence: 8,
  created_at: '2026-08-10T07:00:00Z',
  updated_at: '2026-08-10T07:20:00Z',
  members: [],
  preferences: {
    conversation_id: '019cb111-8ecc-7181-8266-8986d950169b',
    account_id: 'acct_b',
    personal_title: null,
    version: 1,
  },
};
const message: ChatSyncMessage = {
  id: '019cb2c9-0a77-7d84-b81b-97042279ad3d',
  client_message_id: '019cb2c8-d133-7e52-b797-ad871be09d66',
  conversation_id: conversation.id,
  conversation_sequence: 8,
  sender_account_id: 'acct_a',
  kind: 'text',
  content: { schema: 1, blocks: [{ type: 'text', text: 'hello' }] },
  reply_to_message_id: null,
  attachment_ids: [],
  version: 1,
  generation_status: null,
  provider_response_id: null,
  created_at: '2026-08-10T07:20:00Z',
  edited_at: null,
  deleted_at: null,
};

test('bootstrap pin snapshots replace stale private and shared state', async () => {
  const client = new CloudAuthClient({
    baseUrl: 'http://srv',
    fetchImpl: async () => new Response(JSON.stringify({
      protocol_version: 2,
      conversations: [conversation],
      session_visibility: {hiddenSessionIds:[],deletedSessionIds:[],pinnedSessionIds:[],mutedSessionIds:[],unreadSessionIds:[],pinnedGroupSpaceIds:[]},
      latest_messages: [message],
      session_pins: [{
        sessionId,
        sharedMessageId: message.id,
        privateMessageId: null,
        effectiveMessageId: message.id,
        updatedAt: '2026-08-10T07:19:00Z',
      }],
      next_cursor: 'opaque.signed.cursor',
      last_stream_seq: 44,
      server_time: '2026-08-10T07:20:00Z',
    }), { status: 200 }),
  });
  const result = await client.syncCloudEvents('token', '0', 500);
  const cachedEvents = result.chat!.events!.filter(event => event.type === 'session.pin.updated');
  assert.equal(cachedEvents.length, 2, 'Native bootstrap must cache both pin scopes with the messages');
  assert.ok(cachedEvents.every(event => event.conversation_id === conversation.id));
  const pins = applyCloudSyncEventsToSessionPins({
    [sessionId]: {
      sessionId,
      sharedMessageId: 'stale-shared',
      privateMessageId: 'stale-private',
      effectiveMessageId: 'stale-private',
      updatedAt: '2026-08-10T07:18:00Z',
    },
  }, result.events);

  assert.deepEqual(pins[sessionId], {
    sessionId,
    sharedMessageId: message.id,
    privateMessageId: null,
    effectiveMessageId: message.id,
    updatedAt: '2026-08-10T07:19:00Z',
    lastAction: null,
  });
});

test('incremental pin events retain actor activity', async () => {
  const client = new CloudAuthClient({
    baseUrl: 'http://srv',
    fetchImpl: async () => new Response(JSON.stringify({
      protocol_version: 2,
      events: [{
        stream_seq: 46,
        event_id: '019cb2ca-0a77-7d84-b81b-97042279ad3e',
        protocol_version: 2,
        type: 'session.pin.updated',
        critical: true,
        conversation_id: conversation.id,
        entity_id: null,
        entity_version: null,
        occurred_at: '2026-08-10T07:20:02Z',
        payload: {
          sessionId,
          messageId: message.id,
          scope: 'shared',
          updatedByAccountId: 'acct_a',
          updatedAt: '2026-08-10T07:20:02Z',
        },
      }],
      next_cursor: 'opaque.pin.cursor',
      last_stream_seq: 46,
      has_more: false,
      server_time: '2026-08-10T07:20:02Z',
    }), { status: 200 }),
  });
  const result = await client.syncCloudEvents('token', 'opaque.current.cursor', 500);
  const pins = applyCloudSyncEventsToSessionPins({}, result.events);

  assert.deepEqual(pins[sessionId]?.lastAction, {
    kind: 'pinned',
    scope: 'shared',
    messageId: message.id,
    updatedByAccountId: 'acct_a',
    updatedAt: '2026-08-10T07:20:02Z',
  });
});

test('live pin history keeps both actions and deduplicates replay independently of current pin state', () => {
  const pin = { id: 'history-pin', sequence: 1, sessionId, kind: 'pinned', scope: 'shared', messageId: 'target', updatedByAccountId: 'acct_a', updatedAt: '2026-09-14T12:00:00Z' };
  const unpin = { ...pin, id: 'history-unpin', sequence: 2, kind: 'unpinned', messageId: null, updatedAt: '2026-09-14T12:01:00Z' };
  const events = [pin, unpin].map(action => ({ eventId: `delivery-${action.id}`, eventType: 'session.pin.updated', peerAccountId: sessionId, messageId: action.messageId, occurredAt: action.updatedAt, payload: { sessionId, messageId: action.messageId, scope: action.scope, updatedAt: action.updatedAt, updatedByAccountId: action.updatedByAccountId, pinHistoryEvent: action } }));
  const first = applyCloudSyncEventsToSessionPins({}, events);
  assert.equal(first[sessionId].effectiveMessageId, null);
  assert.deepEqual(first[sessionId].history, [pin, unpin]);
  assert.deepEqual(applyCloudSyncEventsToSessionPins(first, events)[sessionId].history, [pin, unpin]);
  assert.equal(applyCloudSyncEventsToSessionPins(first, [events[0]])[sessionId].effectiveMessageId, null);
});

test('legacy sync retains separate notices through unpin responses, replay and server upgrade', async () => {
  const { mergePinHistory, mergePinSnapshot } = await import('../src/features/cloud/cloudPinHistory');
  const events = ['pinned', 'unpinned'].map((kind, index) => ({
    eventId: `legacy-${index}`, eventType: 'session.pin.updated', peerAccountId: sessionId,
    occurredAt: `2026-09-15T10:0${index}:00Z`, messageId: kind === 'pinned' ? 'target' : null,
    payload: { sessionId, scope: 'private', messageId: kind === 'pinned' ? 'target' : null,
      updatedByAccountId: 'acct_a', updatedAt: `2026-09-15T10:0${index}:00Z` },
  }));
  const pinned = applyCloudSyncEventsToSessionPins({}, [events[0]])[sessionId];
  const client = new CloudAuthClient({ baseUrl: 'http://fixture', fetchImpl: async url =>
    String(url).endsWith('/pin-history') ? new Response('', { status: 404 })
      : Response.json({ pin: { sessionId, sharedMessageId: null, privateMessageId: null, effectiveMessageId: null, updatedAt: null } }) });
  const response = await client.updateCloudSessionPin('fixture', sessionId, { messageId: null, scope: 'private' });
  const cleared = mergePinSnapshot(pinned, response);
  assert.equal(cleared.effectiveMessageId, null, 'Legacy unpin response must clear the pin');
  const synced = applyCloudSyncEventsToSessionPins({ [sessionId]: cleared }, events)[sessionId];
  assert.deepEqual(synced.history?.map(event => event.kind), ['pinned', 'unpinned']);
  assert.deepEqual(synced.history?.map(event => event.updatedAt), events.map(event => event.occurredAt));
  assert.equal(applyCloudSyncEventsToSessionPins({ [sessionId]: synced }, events)[sessionId].history?.length, 2);
  const canonical = synced.history!.map((event, index) => ({ ...event, id: `canonical-${index}`, sequence: index + 1 }));
  assert.deepEqual(mergePinHistory(synced.history, canonical), canonical);
  assert.deepEqual(mergePinHistory(canonical, synced.history), canonical);
  assert.equal(mergePinHistory(canonical, [{ ...canonical[0], id: 'another-action' }]).length, 3);
  const remainingShared = mergePinSnapshot(pinned, { ...response, sharedMessageId: 'older-shared', effectiveMessageId: 'older-shared', updatedAt: '2026-09-14T10:00:00Z' });
  assert.equal(remainingShared.privateMessageId, null);
  assert.equal(remainingShared.sharedMessageId, 'older-shared');
});


test('a sync request cannot erase pin history loaded or changed while it was in flight', async () => {
  const { mergePinSyncSnapshot } = await import('../src/features/cloud/cloudPinHistory');
  const pin = { sessionId, sharedMessageId: 'target', privateMessageId: null, effectiveMessageId: 'target', updatedAt: '2026-09-15T10:00:00Z' };
  const event = { id: 'event', sessionId, kind: 'pinned' as const, scope: 'shared' as const, messageId: 'target', updatedByAccountId: 'owner', updatedAt: pin.updatedAt };
  const baseline = { [sessionId]: pin };
  const unpinned = { ...pin, sharedMessageId: null, effectiveMessageId: null, updatedAt: null, history: [event] };
  const merged = mergePinSyncSnapshot({ [sessionId]: unpinned }, baseline, baseline);
  assert.equal(merged[sessionId].effectiveMessageId, null);
  assert.deepEqual(merged[sessionId].history, [event]);
  assert.deepEqual(mergePinSyncSnapshot({ [sessionId]: unpinned }, {}, {})[sessionId], unpinned);
});

test('re-login restores cached actions before a current-pin bootstrap without erasing their history', () => {
  const actions = ['pinned', 'unpinned'].map((kind, index) => ({
    eventId: `retained-${index}`, eventType: 'session.pin.updated', peerAccountId: sessionId,
    messageId: kind === 'pinned' ? 'target' : null, occurredAt: `2026-09-15T10:0${index}:00Z`,
    payload: { sessionId, scope: 'private', messageId: kind === 'pinned' ? 'target' : null,
      updatedByAccountId: 'owner', updatedAt: `2026-09-15T10:0${index}:00Z` },
  }));
  const restoredAfterLogin = applyCloudSyncEventsToSessionPins({}, actions);
  const currentPinOnly = { eventId: `bootstrap:session-pin:${sessionId}:private`, eventType: 'session.pin.updated',
    peerAccountId: null, messageId: null, occurredAt: '2026-09-15T11:00:00Z',
    payload: { sessionId, scope: 'private', messageId: null, updatedAt: '2026-09-15T11:00:00Z' } };
  const refreshed = applyCloudSyncEventsToSessionPins(restoredAfterLogin, [currentPinOnly]);
  assert.equal(refreshed[sessionId].effectiveMessageId, null);
  assert.deepEqual(refreshed[sessionId].history?.map(event => event.kind), ['pinned', 'unpinned']);
  assert.deepEqual(refreshed[sessionId].history?.map(event => event.updatedAt), actions.map(event => event.occurredAt));
});
