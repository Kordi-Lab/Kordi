import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CloudAuthClient,
  chatSyncSessionTitle,
  cloudMessageFromChatSync,
  type ChatSyncConversation,
  type ChatSyncMessage,
} from '../src/features/cloud/authClient';
import { applyCloudSyncEventsToSessionTitles } from '../src/features/cloud/cloudDiffSync';
import { cloudSyncCursorRequiresFallback } from '../src/features/cloud/cloudSyncCursorProgress';
import { planCloudSelfAgentCanonicalSync } from '../src/features/cloud/cloudSelfAgentCanonicalSync';
import type { CanonicalSessionState } from '../src/kordi-app/types';
const conversation: ChatSyncConversation = {
  id: '019cb111-8ecc-7181-8266-8986d950169b',
  kind: 'direct',
  shared_title: 'Synced title',
  version: 3,
  created_by_account_id: 'acct_a',
  legacy_session_id: 'session:direct-person:acct_a:acct_b',
  latest_message_sequence: 8,
  created_at: '2026-08-10T07:00:00Z',
  updated_at: '2026-08-10T07:20:00Z',
  members: [
    { account_id: 'acct_a', role: 'owner', membership_state: 'active', version: 1, last_delivered_sequence: 8, last_read_sequence: 8, joined_at: '2026-08-10T07:00:00Z', left_at: null },
    { account_id: 'acct_b', role: 'member', membership_state: 'active', version: 1, last_delivered_sequence: 8, last_read_sequence: 8, joined_at: '2026-08-10T07:00:00Z', left_at: null },
  ],
  preferences: { conversation_id: '019cb111-8ecc-7181-8266-8986d950169b', account_id: 'acct_b', personal_title: null, version: 1 },
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
  reactions: [{ reaction: 'blob:blobwave', account_ids: ['acct_a'] }],
};
test('bootstrap returns a durable canonical local-apply batch', async () => {
  const calls: string[] = [];
  const client = new CloudAuthClient({
    baseUrl: 'http://srv',
    fetchImpl: async (input) => {
      calls.push(input.toString());
      return new Response(JSON.stringify({
        protocol_version: 2,
        conversations: [conversation],
        latest_messages: [message],
        next_cursor: 'opaque.signed.cursor',
        last_stream_seq: 44,
        server_time: '2026-08-10T07:20:00Z',
      }), { status: 200 });
    },
  });
  const result = await client.syncCloudEvents('token', '0', 500);
  assert.deepEqual(calls, ['http://srv/v2/chat/sync/bootstrap']);
  assert.equal(result.cursor, 'opaque.signed.cursor');
  assert.equal(result.chat?.bootstrap, true);
  assert.equal(result.chat?.lastStreamSeq, 44);
  assert.equal(result.events.find((event) => event.eventType === 'message.upsert')?.messageId, message.id);
  assert.deepEqual(
    client.knownChatSessionIds('acct_b'),
    ['session:direct-person:acct_a:acct_b'],
  );
  assert.deepEqual(client.knownChatSessionIds('acct_a'), []);
});
test('incremental reaction sync preserves its cursor and confirms reaction state', async () => {
  const calls: string[] = [];
  const client = new CloudAuthClient({
    baseUrl: 'http://srv',
    fetchImpl: async (input) => {
      calls.push(input.toString());
      return new Response(JSON.stringify({
        protocol_version: 2,
        events: [{
          stream_seq: 45,
          event_id: '019cb2ca-0a77-7d84-b81b-97042279ad3d',
          protocol_version: 2,
          type: 'reaction.updated',
          critical: true,
          conversation_id: conversation.id,
          entity_id: message.id,
          entity_version: 1,
          occurred_at: message.created_at,
          payload: { conversation, message },
        }],
        next_cursor: 'opaque.next.cursor',
        last_stream_seq: 45,
        has_more: false,
        server_time: '2026-08-10T07:20:01Z',
      }), { status: 200 });
    },
  });
  const result = await client.syncCloudEvents('token', 'opaque.current.cursor', 500);
  assert.equal(calls[0], 'http://srv/v2/chat/sync?cursor=opaque.current.cursor&limit=500');
  assert.equal(result.chat?.bootstrap, false);
  assert.equal(result.chat?.lastStreamSeq, 45);
  assert.equal(result.events[0].eventType, 'message.upsert');
  assert.equal((result.events[0].payload as { reactionStateConfirmed?: boolean }).reactionStateConfirmed, true);
});
test('ancillary snapshots reach the existing local projections through canonical sync', async () => {
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
          sessionId: conversation.legacy_session_id,
          messageId: message.id,
          scope: 'shared',
        },
      }],
      next_cursor: 'opaque.pin.cursor',
      last_stream_seq: 46,
      has_more: false,
      server_time: '2026-08-10T07:20:02Z',
    }), { status: 200 }),
  });
  const result = await client.syncCloudEvents('token', 'opaque.current.cursor', 500);
  assert.equal(result.events[0]?.eventType, 'session.pin.updated');
  assert.equal(result.events[0]?.payload.sessionId, conversation.legacy_session_id);
  assert.equal(result.chat?.events[0]?.type, 'session.pin.updated');
});
test('history backfill uses conversation sequences and preserves canonical snapshots', async () => {
  const calls: string[] = [];
  const older = { ...message, id: '019cb2c9-0a77-7d84-b81b-97042279ad30', conversation_sequence: 7 };
  const client = new CloudAuthClient({
    baseUrl: 'http://srv',
    fetchImpl: async (input) => {
      calls.push(input.toString());
      return new Response(JSON.stringify({
        messages: [older],
        next_before_sequence: null,
        has_more: false,
      }), { status: 200 });
    },
  });

  const result = await client.listChatConversationHistoryPage('token', conversation.id, 8, 500);
  assert.equal(
    calls[0],
    `http://srv/v2/chat/conversations/${conversation.id}/messages?limit=200&before_sequence=8`,
  );
  assert.deepEqual(result.messages, [older]);
  assert.equal(result.hasMore, false);
});

test('canonical snapshots derive delivery and read state from monotonic member cursors', () => {
  const mapped = cloudMessageFromChatSync(message, conversation, 'acct_b');
  assert.equal(mapped.body, 'hello');
  assert.equal(mapped.conversationSequence, 8);
  assert.equal(mapped.deliveredAt, message.created_at);
  assert.equal(mapped.readAt, message.created_at);
  assert.deepEqual(mapped.reactions, [{ value: 'blob:blobwave', accountIds: ['acct_a'] }]);
});

test('canonical history snapshots preserve original time and message kind', async () => {
  const originalCreatedAt = '2026-07-01T02:03:04.000Z';
  let sentBody: Record<string, unknown> | null = null;
  const client = new CloudAuthClient({
    baseUrl: 'http://srv',
    fetchImpl: async (input, init) => {
      const url = input.toString();
      if (url.endsWith('/sync/bootstrap')) {
        return new Response(JSON.stringify({
          protocol_version: 2,
          conversations: [conversation],
          latest_messages: [],
          next_cursor: 'opaque.history',
          last_stream_seq: 1,
          server_time: message.created_at,
        }), { status: 200 });
      }
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const requestContent = sentBody.content;
      return new Response(JSON.stringify({
        message: {
          ...message,
          kind: sentBody.kind,
          content: requestContent,
        },
      }), { status: 201 });
    },
  });
  await client.syncCloudEvents('token', '0');

  const restored = await client.sendMessage('token', 'acct_a', 'old text', {
    sessionId: conversation.legacy_session_id,
    clientCreatedAt: originalCreatedAt,
    clientMessageId: 'restore-operation',
    messageKind: 'canonical-history-user',
    canonicalHistoryLocalMessageId: 'local-old-message',
  });

  assert.equal(sentBody?.kind, 'canonical-history-user');
  assert.deepEqual(
    (sentBody?.content as {
      canonical_history?: unknown;
    }).canonical_history,
    {
      local_message_id: 'local-old-message',
      original_created_at: originalCreatedAt,
    },
  );
  assert.equal(restored.createdAt, originalCreatedAt);
  assert.equal(restored.messageKind, 'canonical-history-user');
  assert.equal(
    restored.canonicalHistoryLocalMessageId,
    'local-old-message',
  );
});

test('canonical history snapshot reuses the source-device local message id', () => {
  const originalCreatedAt = '2026-07-01T02:03:04.000Z';
  const restored = cloudMessageFromChatSync({
    ...message,
    id: '019cb2c9-0a77-7d84-b81b-97042279ad39',
    kind: 'canonical-history-user',
    content: {
      schema: 1,
      blocks: [{ type: 'text', text: 'old text' }],
      canonical_history: {
        local_message_id: 'local-old-message',
        original_created_at: originalCreatedAt,
      },
    },
  }, {
    ...conversation,
    kind: 'ai',
    legacy_session_id: 'session:old-agent',
    preferences: { ...conversation.preferences, account_id: 'acct_a' },
  }, 'acct_a');
  const state = {
    profile: { humanIdentityId: 'human:acct_a' },
    identities: [],
    sessions: [{
      id: 'session:old-agent',
      kind: 'self-agent',
      title: 'Old agent',
      status: 'active',
      createdAtMs: 1,
      updatedAtMs: 1,
    }],
    participants: [],
    messages: [{
      id: 'local-old-message',
      sessionId: 'session:old-agent',
      senderIdentityId: 'human:acct_a',
      senderRole: 'user',
      messageKind: 'text',
      contentText: 'old text',
      status: 'sent',
      sequenceNum: 1,
      createdAtMs: Date.parse(originalCreatedAt),
      updatedAtMs: Date.parse(originalCreatedAt),
      sourceTransport: 'cloud-self-agent',
      sourceEventId: 'legacy-message-id',
    }],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/source-device.sqlite3',
  } as CanonicalSessionState;

  const plan = planCloudSelfAgentCanonicalSync({
    account: {
      accountId: 'acct_a',
      displayName: 'A',
      primaryEmail: null,
      avatarUrl: null,
      nodeId: null,
    },
    messages: [restored],
    state,
  });

  assert.deepEqual(plan.messageRequests, []);
});

test('canonical group snapshots become read after any recipient reads without waiting for every member', () => {
  const groupConversation: ChatSyncConversation = {
    ...conversation,
    kind: 'group',
    members: [
      { ...conversation.members[0], last_delivered_sequence: 8, last_read_sequence: 8 },
      { ...conversation.members[1], last_delivered_sequence: 8, last_read_sequence: 8 },
      {
        account_id: 'acct_c',
        role: 'member',
        membership_state: 'active',
        version: 1,
        last_delivered_sequence: 0,
        last_read_sequence: 0,
        joined_at: '2026-08-10T07:00:00Z',
        left_at: null,
      },
    ],
    preferences: { ...conversation.preferences, account_id: 'acct_a' },
  };
  const mapped = cloudMessageFromChatSync(message, groupConversation, 'acct_a');

  assert.equal(mapped.readAt, message.created_at);
});

test('group bootstrap uses the shared Cloud channel title and ignores personal titles', async () => {
  const groupConversation: ChatSyncConversation = {
    ...conversation,
    kind: 'group',
    shared_title: 'Channel planning',
    legacy_session_id: 'session:group:title-safe',
    preferences: { ...conversation.preferences, personal_title: 'Legacy local title' },
  };
  assert.equal(chatSyncSessionTitle(groupConversation), 'Channel planning');

  const client = new CloudAuthClient({
    baseUrl: 'http://srv',
    fetchImpl: async () => new Response(JSON.stringify({
      protocol_version: 2,
      conversations: [groupConversation],
      latest_messages: [],
      next_cursor: 'opaque.group.title',
      last_stream_seq: 9,
      server_time: '2026-08-10T07:20:00Z',
    }), { status: 200 }),
  });
  const result = await client.syncCloudEvents('token', '0');
  const titleEvent = result.events.find((event) => event.eventType === 'session.title.updated');
  assert.equal((titleEvent?.payload.sessionTitle as { title?: string })?.title, 'Channel planning');

  const sessionId = groupConversation.legacy_session_id!;
  const updated = applyCloudSyncEventsToSessionTitles({
    [sessionId]: {
      sessionId,
      title: 'Generated member fallback',
      titleSource: 'external',
      titleRevision: 1,
      titlePolicyVersion: 1,
      titleGeneratedFromMessageId: null,
      updatedAtMs: 1,
      updatedByAccountId: 'acct_a',
      updatedAt: '2026-08-10T07:00:00Z',
    },
  }, result.events);
  assert.equal(updated[sessionId]?.title, 'Channel planning');
});

test('chat bootstrap snapshots reconstruct every historical My Kordi session', () => {
  const aiConversation = (id: string, sessionId: string): ChatSyncConversation => ({
    ...conversation,
    id,
    kind: 'ai',
    created_by_account_id: 'acct_b',
    legacy_session_id: sessionId,
    members: [conversation.members[1]],
    preferences: { ...conversation.preferences, conversation_id: id },
  });
  const firstConversation = aiConversation(
    '019cb111-8ecc-7181-8266-8986d9501601',
    'session:my-kordi:first',
  );
  const secondConversation = aiConversation(
    '019cb111-8ecc-7181-8266-8986d9501602',
    'session:my-kordi:second',
  );
  const firstMessage: ChatSyncMessage = {
    ...message,
    id: '019cb2c9-0a77-7d84-b81b-97042279ad31',
    conversation_id: firstConversation.id,
    sender_account_id: 'acct_b',
    content: { schema: 1, blocks: [{ type: 'text', text: 'First restored chat' }] },
  };
  const secondMessage: ChatSyncMessage = {
    ...message,
    id: '019cb2c9-0a77-7d84-b81b-97042279ad32',
    conversation_id: secondConversation.id,
    sender_account_id: 'acct_b',
    content: { schema: 1, blocks: [{ type: 'text', text: 'Second restored chat' }] },
  };
  const restored = [
    cloudMessageFromChatSync(firstMessage, firstConversation, 'acct_b'),
    cloudMessageFromChatSync(secondMessage, secondConversation, 'acct_b'),
  ];
  const state = {
    profile: { humanIdentityId: 'human:acct_b' },
    identities: [],
    sessions: [],
    participants: [],
    messages: [],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/device-b/canonical.sqlite3',
  } as CanonicalSessionState;

  const plan = planCloudSelfAgentCanonicalSync({
    account: {
      accountId: 'acct_b',
      displayName: 'Taylor',
      primaryEmail: null,
      avatarUrl: null,
      nodeId: null,
    },
    messages: restored,
    state,
  });

  assert.deepEqual(
    plan.sessionRequests.map((request) => request.id).sort(),
    ['session:my-kordi:first', 'session:my-kordi:second'],
  );
  assert.deepEqual(
    plan.messageRequests.map((request) => request.contentText).sort(),
    ['First restored chat', 'Second restored chat'],
  );
});

test('opaque cursors are never parsed or ordered by the client', () => {
  assert.equal(cloudSyncCursorRequiresFallback('zzz', 'aaa', false), false);
  assert.equal(cloudSyncCursorRequiresFallback('same', 'same', true), true);
  assert.equal(cloudSyncCursorRequiresFallback('previous', '', false), true);
});

test('group control envelopes replace canonical membership and remove omitted recipients', async () => {
  const removedMember = {
    account_id: 'acct_removed', role: 'member', membership_state: 'active', version: 1,
    last_delivered_sequence: 0, last_read_sequence: 0,
    joined_at: '2026-08-10T07:00:00Z', left_at: null,
  };
  const group = {
    ...conversation,
    kind: 'group' as const,
    legacy_session_id: 'session:group:secure',
    preferences: { ...conversation.preferences, account_id: 'acct_b' },
    members: [...conversation.members, removedMember],
  };
  const calls: Array<{ url: string; body: unknown }> = [];
  const client = new CloudAuthClient({
    baseUrl: 'http://srv',
    fetchImpl: async (input, init) => {
      const url = input.toString();
      calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : null });
      if (url.endsWith('/sync/bootstrap')) {
        return new Response(JSON.stringify({
          protocol_version: 2,
          conversations: [group],
          latest_messages: [],
          next_cursor: 'opaque',
          last_stream_seq: 1,
          server_time: '2026-08-10T07:20:00Z',
        }), { status: 200 });
      }
      if (url.endsWith('/members')) {
        return new Response(JSON.stringify({
          conversation: {
            ...group,
            version: group.version + 1,
            members: group.members.map((member) => member.account_id === 'acct_removed'
              ? { ...member, membership_state: 'removed' }
              : member),
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ message }), { status: 201 });
    },
  });
  await client.syncCloudEvents('token', '0');
  const envelope = `kordi-cloud-group:${Buffer.from(JSON.stringify({
    participants: [{ accountId: 'acct_a' }, { accountId: 'acct_b' }],
  })).toString('base64url')}`;
  await client.sendMessage('token', 'acct_a', envelope, {
    sessionId: group.legacy_session_id,
    conversationKind: 'group',
    memberAccountIds: ['acct_a', 'acct_removed'],
  });

  const membership = calls.find((call) => call.url.endsWith('/members'));
  assert.ok(membership);
  assert.deepEqual((membership.body as { member_account_ids: string[] }).member_account_ids.sort(), ['acct_a', 'acct_b']);
  assert.equal((membership.body as { replace: boolean }).replace, true);
});
