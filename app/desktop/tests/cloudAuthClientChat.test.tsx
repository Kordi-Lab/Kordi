import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CloudAuthClient } from '../src/features/cloud/authClient';
import { ChatSyncState } from '../src/features/cloud/chatSyncState';

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

function chatConversation(overrides: Record<string, unknown> = {}) {
  return {
    id: '019cb111-8ecc-7181-8266-8986d950169b',
    kind: 'direct',
    shared_title: null,
    version: 1,
    created_by_account_id: 'acct_me',
    legacy_session_id: 'session:direct-person:acct_me:acct_peer',
    latest_message_sequence: 0,
    created_at: '2026-05-12T00:00:00Z',
    updated_at: '2026-05-12T00:00:00Z',
    members: [
      { account_id: 'acct_me', role: 'owner', membership_state: 'active', version: 1, last_delivered_sequence: 0, last_read_sequence: 0, joined_at: '2026-05-12T00:00:00Z', left_at: null },
      { account_id: 'acct_peer', role: 'member', membership_state: 'active', version: 1, last_delivered_sequence: 0, last_read_sequence: 0, joined_at: '2026-05-12T00:00:00Z', left_at: null },
    ],
    preferences: { conversation_id: '019cb111-8ecc-7181-8266-8986d950169b', account_id: 'acct_me', personal_title: null, version: 1 },
    ...overrides,
  };
}

test('rekeyed and deleted sessions release stale local routing identities', () => {
  const state = new ChatSyncState(
    async () => { throw new Error('unused'); },
    () => 'acct_me',
    () => undefined,
    () => null,
  );
  const legacy = chatConversation({
    kind: 'ai',
    legacy_session_id: 'session:direct-system-agent:acct_me:cloud_agent_kordi_support',
    members: [chatConversation().members[0]],
  });
  state.rememberConversation(legacy);
  state.rememberConversation({
    ...legacy,
    version: 2,
    legacy_session_id: `session:quarantined-support:${legacy.id}`,
  });

  assert.deepEqual(state.knownSessionIds('acct_me'), [
    `session:quarantined-support:${legacy.id}`,
  ]);

  state.forgetSession(`session:quarantined-support:${legacy.id}`);
  assert.deepEqual(state.knownSessionIds('acct_me'), []);
});

test('expressive media client lists and saves account-owned library items', async () => {
  const mediaItem = {
    itemId: 'media-1',
    attachmentId: 'attachment-1',
    kind: 'sticker' as const,
    name: 'wave.webp',
    mimeType: 'image/webp',
    sizeBytes: 128,
    createdAt: '2026-08-17T10:00:00Z',
    updatedAt: '2026-08-17T10:00:00Z',
  };
  const { calls, fetchImpl } = recordingFetch((call) => (
    call.init?.method === 'POST'
      ? jsonResponse(200, { item: mediaItem })
      : jsonResponse(200, { items: [mediaItem] })
  ));
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  assert.deepEqual(await client.listExpressiveMedia('token-a'), [mediaItem]);
  assert.deepEqual(await client.saveExpressiveMedia('token-a', {
    attachmentId: 'attachment-1',
    kind: 'sticker',
    name: 'wave.webp',
  }), mediaItem);

  assert.equal(calls[0].url, 'http://srv/v1/cloud/expressive-media');
  assert.equal(calls[0].init?.method, 'GET');
  assert.equal(calls[1].init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), {
    attachmentId: 'attachment-1',
    kind: 'sticker',
    name: 'wave.webp',
  });
});

test('sendMessage uses canonical conversation identity and canonical idempotent message writes', async () => {
  const { calls, fetchImpl } = recordingFetch((call) => {
    if (call.url.endsWith('/v2/chat/conversations')) {
      return jsonResponse(201, { conversation: chatConversation() });
    }
    return jsonResponse(201, {
      message: {
        id: '019cb2c9-0a77-7d84-b81b-97042279ad3d',
        client_message_id: '019cb2c8-d133-7e52-b797-ad871be09d66',
        conversation_id: '019cb111-8ecc-7181-8266-8986d950169b',
        conversation_sequence: 1,
        sender_account_id: 'acct_me',
        kind: 'text',
        content: {
          schema: 1,
          blocks: [{ type: 'text', text: 'see file' }],
          legacy_attachments: [{ attachmentId: 'att_1', name: 'report.pdf', kind: 'file', mimeType: 'application/pdf', sizeBytes: 1000 }],
        },
        reply_to_message_id: null,
        attachment_ids: ['att_1'],
        version: 1,
        generation_status: null,
        provider_response_id: null,
        created_at: '2026-05-12T00:00:00Z',
        edited_at: null,
        deleted_at: null,
      },
    });
  });
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  const sent = await client.sendMessage('kordi_cs_xyz', 'acct_peer', 'see file', {
    sessionId: 'session-1',
    accountId: 'acct_me',
    clientMessageId: 'msg:canonical:one:acct_peer',
    attachments: [{
      attachmentId: 'att_1',
      name: 'report.pdf',
      kind: 'file',
      mimeType: 'application/pdf',
      sizeBytes: 1000,
    }],
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'http://srv/v2/chat/conversations');
  const createBody = JSON.parse(calls[0].init?.body as string);
  assert.equal(createBody.client_session_id, 'session-1');
  assert.equal(createBody.kind, 'direct');
  assert.deepEqual(createBody.member_account_ids, ['acct_peer']);
  assert.equal(calls[1].url, 'http://srv/v2/chat/conversations/019cb111-8ecc-7181-8266-8986d950169b/messages');
  const sendBody = JSON.parse(calls[1].init?.body as string);
  assert.equal(sendBody.kind, 'text');
  assert.equal(sendBody.content.blocks[0].text, 'see file');
  assert.deepEqual(sendBody.attachment_ids, ['att_1']);
  assert.match(sendBody.client_message_id, /^[0-9a-f-]{36}$/);
  assert.equal(sent.messageId, '019cb2c9-0a77-7d84-b81b-97042279ad3d');
  assert.equal(sent.conversationSequence, 1);
  assert.equal(sent.attachments?.[0]?.attachmentId, 'att_1');
});

test('setReaction restores a missing conversation cache before mutating', async () => {
  const conversation = chatConversation();
  const message = {
    id: '019cb2c9-0a77-7d84-b81b-97042279ad3d',
    client_message_id: '019cb2c8-d133-7e52-b797-ad871be09d66',
    conversation_id: conversation.id,
    conversation_sequence: 1,
    sender_account_id: 'acct_peer',
    kind: 'text',
    content: { schema: 1, blocks: [{ type: 'text', text: 'React here' }] },
    reply_to_message_id: null,
    attachment_ids: [],
    version: 1,
    generation_status: null,
    provider_response_id: null,
    created_at: '2026-05-12T00:00:00Z',
    edited_at: null,
    deleted_at: null,
    reactions: [{ reaction: 'blob:blobwave', account_ids: ['acct_me'] }],
  };
  const { calls, fetchImpl } = recordingFetch((call) => (
    call.url.endsWith('/sync/bootstrap')
      ? jsonResponse(200, {
          protocol_version: 2,
          conversations: [conversation],
          latest_messages: [],
          next_cursor: 'opaque',
          last_stream_seq: 1,
          server_time: '2026-05-12T00:00:00Z',
        })
      : jsonResponse(200, { message })
  ));
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  const updated = await client.setReaction(
    'kordi_cs_xyz',
    conversation.id,
    message.id,
    'blob:blobwave',
    true,
  );

  assert.equal(calls[0].url, 'http://srv/v2/chat/sync/bootstrap');
  assert.equal(calls[1].url, `http://srv/v2/chat/conversations/${conversation.id}/messages/${message.id}/reactions`);
  assert.deepEqual(updated.reactions, [{ value: 'blob:blobwave', accountIds: ['acct_me'] }]);
});

test('sendMessage round-trips meme subtype and alt text in canonical attachment metadata', async () => {
  let sentContent: Record<string, unknown> | null = null;
  const { fetchImpl } = recordingFetch((call) => {
    if (call.url.endsWith('/v2/chat/conversations')) {
      return jsonResponse(201, { conversation: chatConversation() });
    }
    const body = JSON.parse(String(call.init?.body)) as Record<string, unknown>;
    sentContent = body.content as Record<string, unknown>;
    return jsonResponse(201, {
      message: {
        id: '019cb2c9-0a77-7d84-b81b-97042279ad3e',
        client_message_id: body.client_message_id,
        conversation_id: '019cb111-8ecc-7181-8266-8986d950169b',
        conversation_sequence: 1,
        sender_account_id: 'acct_me',
        kind: 'text',
        content: sentContent,
        reply_to_message_id: null,
        attachment_ids: ['att_meme'],
        version: 1,
        generation_status: null,
        provider_response_id: null,
        created_at: '2026-05-12T00:00:00Z',
        edited_at: null,
        deleted_at: null,
      },
    });
  });
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  const sent = await client.sendMessage('kordi_cs_xyz', 'acct_peer', '', {
    sessionId: 'session-meme',
    accountId: 'acct_me',
    clientMessageId: 'msg:canonical:meme:acct_peer',
    attachments: [{
      attachmentId: 'att_meme',
      name: 'reaction.webp',
      kind: 'image',
      subtype: 'meme',
      altText: 'A character celebrates when the build turns green.',
      mimeType: 'image/webp',
      sizeBytes: 1_024,
    }],
  });

  const metadata = (sentContent?.legacy_attachments as Array<Record<string, unknown>>)[0];
  assert.equal(metadata?.subtype, 'meme');
  assert.equal(metadata?.altText, 'A character celebrates when the build turns green.');
  assert.equal(sent.attachments?.[0]?.subtype, 'meme');
  assert.equal(sent.attachments?.[0]?.altText, 'A character celebrates when the build turns green.');
});

test('markMessagesRead advances the monotonic canonical conversation cursor', async () => {
  const { calls, fetchImpl } = recordingFetch((call) => {
    if (call.url.endsWith('/v1/cloud/auth/me')) {
      return jsonResponse(200, { accountId: 'acct_me', displayName: 'Me', primaryEmail: null, avatarUrl: null, passwordSet: true });
    }
    if (call.url.endsWith('/v2/chat/conversations')) {
      return jsonResponse(200, { conversation: chatConversation({ latest_message_sequence: 7 }) });
    }
    return jsonResponse(200, { cursor: { conversation_id: '019cb111-8ecc-7181-8266-8986d950169b', account_id: 'acct_me', last_delivered_sequence: 7, last_read_sequence: 7 } });
  });
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  await client.me('kordi_cs_xyz');
  await client.markMessagesRead('kordi_cs_xyz', 'acct_peer');

  assert.equal(calls.length, 3);
  assert.equal(calls[2].url, 'http://srv/v2/chat/conversations/019cb111-8ecc-7181-8266-8986d950169b/read');
  assert.equal(calls[2].init?.method, 'PUT');
  const headers = calls[2].init?.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer kordi_cs_xyz');
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(JSON.parse(calls[2].init?.body as string).sequence, 7);
});

test('markSessionMessagesRead resolves a session from chat bootstrap and advances read state', async () => {
  const group = chatConversation({
    id: '019cb111-8ecc-7181-8266-8986d9501700',
    kind: 'group',
    legacy_session_id: 'session:group:one',
    latest_message_sequence: 9,
    preferences: { conversation_id: '019cb111-8ecc-7181-8266-8986d9501700', account_id: 'acct_me', personal_title: null, version: 1 },
  });
  const { calls, fetchImpl } = recordingFetch((call) => call.url.endsWith('/sync/bootstrap')
    ? jsonResponse(200, { protocol_version: 2, conversations: [group], latest_messages: [], next_cursor: 'opaque', last_stream_seq: 4, server_time: '2026-05-12T00:00:00Z' })
    : jsonResponse(200, { cursor: { conversation_id: group.id, account_id: 'acct_me', last_delivered_sequence: 9, last_read_sequence: 9 } }));
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  await client.markSessionMessagesRead('kordi_cs_xyz', 'session:group:one');

  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, `http://srv/v2/chat/conversations/${group.id}/read`);
  assert.equal(calls[1].init?.method, 'PUT');
  const headers = calls[1].init?.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer kordi_cs_xyz');
});

test('session title edits use per-user canonical preferences so every device converges', async () => {
  const initial = chatConversation();
  const { calls, fetchImpl } = recordingFetch((call) => call.url.endsWith('/sync/bootstrap')
    ? jsonResponse(200, {
        protocol_version: 2,
        conversations: [initial],
        latest_messages: [],
        next_cursor: 'opaque',
        last_stream_seq: 1,
        server_time: '2026-05-12T00:00:00Z',
      })
    : jsonResponse(200, {
        preferences: {
          ...initial.preferences,
          personal_title: 'My synced title',
          version: 2,
        },
      }));
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  const title = await client.updateCloudSessionTitle(
    'kordi_cs_xyz',
    initial.legacy_session_id,
    {
      title: 'My synced title',
      titleSource: 'manual',
      titleRevision: 1,
      titlePolicyVersion: 1,
      titleGeneratedFromMessageId: null,
      updatedAtMs: Date.parse('2026-05-12T00:01:00Z'),
    },
  );

  assert.equal(title.title, 'My synced title');
  assert.equal(calls[1].url, `http://srv/v2/chat/conversations/${initial.id}/preferences`);
  const body = JSON.parse(calls[1].init?.body as string);
  assert.equal(body.expected_preferences_version, 1);
  assert.equal(body.personal_title, 'My synced title');
});

test('session title edits recover from a concurrent-device preference version', async () => {
  const initial = chatConversation();
  const refreshed = chatConversation({
    preferences: { ...initial.preferences, personal_title: 'Other device title', version: 2 },
  });
  let bootstrapCount = 0;
  let preferenceCount = 0;
  const { calls, fetchImpl } = recordingFetch((call) => {
    if (call.url.endsWith('/sync/bootstrap')) {
      bootstrapCount += 1;
      return jsonResponse(200, {
        protocol_version: 2,
        conversations: [bootstrapCount === 1 ? initial : refreshed],
        latest_messages: [],
        next_cursor: `opaque-${bootstrapCount}`,
        last_stream_seq: bootstrapCount,
        server_time: '2026-05-12T00:00:00Z',
      });
    }
    preferenceCount += 1;
    if (preferenceCount === 1) {
      return jsonResponse(409, { error: { code: 'VERSION_CONFLICT', message: 'changed' } });
    }
    return jsonResponse(200, {
      preferences: { ...refreshed.preferences, personal_title: 'Winning title', version: 3 },
    });
  });
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  const title = await client.updateCloudSessionTitle(
    'kordi_cs_xyz',
    initial.legacy_session_id,
    {
      title: 'Winning title',
      titleSource: 'manual',
      titleRevision: 1,
      titlePolicyVersion: 1,
      titleGeneratedFromMessageId: null,
      updatedAtMs: Date.parse('2026-05-12T00:02:00Z'),
    },
  );

  const preferenceCalls = calls.filter((call) => call.url.endsWith('/preferences'));
  assert.equal(title.title, 'Winning title');
  assert.equal(preferenceCalls.length, 2);
  assert.equal(JSON.parse(preferenceCalls[0].init?.body as string).expected_preferences_version, 1);
  assert.equal(JSON.parse(preferenceCalls[1].init?.body as string).expected_preferences_version, 2);
});

test('session title sync is a no-op when reliable preferences already match', async () => {
  const initial = chatConversation({
    preferences: {
      ...chatConversation().preferences,
      personal_title: 'Already synced',
    },
  });
  const { calls, fetchImpl } = recordingFetch((call) => {
    if (call.url.endsWith('/sync/bootstrap')) {
      return jsonResponse(200, {
        protocol_version: 2,
        conversations: [initial],
        latest_messages: [],
        next_cursor: 'opaque-1',
        last_stream_seq: 1,
        server_time: '2026-05-12T00:00:00Z',
      });
    }
    throw new Error(`Unexpected request: ${call.url}`);
  });
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });

  const title = await client.updateCloudSessionTitle(
    'kordi_cs_xyz',
    initial.legacy_session_id,
    {
      title: 'Already synced',
      titleSource: 'auto',
      titleRevision: 1,
      titlePolicyVersion: 1,
      titleGeneratedFromMessageId: 'message-1',
      updatedAtMs: Date.parse('2026-05-12T00:01:00Z'),
    },
  );

  assert.equal(title.title, 'Already synced');
  assert.equal(calls.filter((call) => call.url.endsWith('/preferences')).length, 0);
});
