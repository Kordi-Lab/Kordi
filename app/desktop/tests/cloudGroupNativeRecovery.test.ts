import assert from 'node:assert/strict';
import { test } from 'node:test';

import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';

import type {
  ChatSyncConversation,
  ChatSyncMessage,
} from '../src/features/cloud/chatSyncTypes';
import { encodeCloudGroupControl } from '../src/features/cloud/cloudGroupMessages';
import { recoverNativeCloudGroupHistory } from '../src/features/cloud/cloudGroupNativeRecovery';

const ACCOUNT_ID = 'acct_me';
const CONVERSATION_ID = 'conversation-group-history';
const SESSION_ID = 'session:group:history';

const conversation: ChatSyncConversation = {
  id: CONVERSATION_ID,
  kind: 'group',
  shared_title: 'History group',
  version: 1,
  created_by_account_id: ACCOUNT_ID,
  legacy_session_id: SESSION_ID,
  latest_message_sequence: 201,
  created_at: '2026-08-28T00:00:00Z',
  updated_at: '2026-08-28T00:00:00Z',
  members: [
    {
      account_id: ACCOUNT_ID,
      display_name: 'Me',
      role: 'owner',
      membership_state: 'active',
      version: 1,
      last_delivered_sequence: 201,
      last_read_sequence: 201,
      joined_at: '2026-08-28T00:00:00Z',
      left_at: null,
    },
    {
      account_id: 'acct_peer',
      display_name: 'Peer',
      role: 'member',
      membership_state: 'active',
      version: 1,
      last_delivered_sequence: 201,
      last_read_sequence: 201,
      joined_at: '2026-08-28T00:00:00Z',
      left_at: null,
    },
  ],
  preferences: {
    conversation_id: CONVERSATION_ID,
    account_id: ACCOUNT_ID,
    personal_title: null,
    version: 1,
  },
};

function message(sequence: number): ChatSyncMessage {
  const createdAt = `2026-08-28T00:${String(Math.floor(sequence / 60)).padStart(2, '0')}:${String(sequence % 60).padStart(2, '0')}Z`;
  const body = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: SESSION_ID,
    groupSpaceId: null,
    groupTitle: 'History group',
    createdByAccountId: ACCOUNT_ID,
    actor: {
      accountId: 'acct_peer',
      displayName: 'Peer',
      avatarUrl: null,
      role: 'person',
    },
    participants: [
      {
        accountId: ACCOUNT_ID,
        displayName: 'Me',
        avatarUrl: null,
        role: 'person',
      },
      {
        accountId: 'acct_peer',
        displayName: 'Peer',
        avatarUrl: null,
        role: 'person',
      },
    ],
    message: {
      id: `canonical-${sequence}`,
      senderAccountId: 'acct_peer',
      senderKind: 'human',
      senderDisplayName: 'Peer',
      text: `Message ${sequence}`,
      createdAtMs: Date.parse(createdAt),
    },
  });
  return {
    id: `wire-${sequence}`,
    client_message_id: `client-${sequence}`,
    conversation_id: CONVERSATION_ID,
    conversation_sequence: sequence,
    sender_account_id: 'acct_peer',
    kind: 'message',
    content: { schema: 1, blocks: [{ type: 'text', text: body }] },
    reply_to_message_id: null,
    attachment_ids: [],
    version: 1,
    generation_status: null,
    provider_response_id: null,
    created_at: createdAt,
    edited_at: null,
    deleted_at: null,
  };
}

function mockNativeHistory(messages: ChatSyncMessage[]) {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {},
  });
  let pageRequests = 0;
  mockIPC((command, payload) => {
    if (command === 'desktop_chat_sync_conversations') {
      return [{ ...conversation, latest_message_sequence: messages.length }];
    }
    if (command === 'desktop_chat_sync_coverage') {
      return [{
        conversationId: CONVERSATION_ID,
        earliestSequence: messages.length > 0 ? 1 : 0,
        latestSequence: messages.length,
        messageCount: messages.length,
      }];
    }
    if (command === 'desktop_canonical_existing_message_sources') return [];
    if (command !== 'desktop_chat_sync_messages_page') {
      throw new Error(`Unexpected native command: ${command}`);
    }
    pageRequests += 1;
    const afterSequence = Number(payload?.afterSequence ?? 0);
    const pageMessages = messages.slice(afterSequence, afterSequence + 100);
    const nextAfterSequence = pageMessages.at(-1)?.conversation_sequence ?? null;
    return {
      conversationId: CONVERSATION_ID,
      messages: pageMessages,
      nextAfterSequence,
      hasMore: afterSequence + pageMessages.length < messages.length,
    };
  });
  return {
    pageRequests: () => pageRequests,
    restore() {
      clearMocks();
      if (windowDescriptor) {
        Object.defineProperty(globalThis, 'window', windowDescriptor);
      } else {
        delete (globalThis as { window?: unknown }).window;
      }
    },
  };
}

test('cold native recovery publishes the latest group page before older history', async () => {
  const native = mockNativeHistory(
    Array.from({ length: 201 }, (_, index) => message(index + 1)),
  );
  const applied: number[] = [];
  const events: string[] = [];
  const flushAfter: number[] = [];
  try {
    const recovered = await recoverNativeCloudGroupHistory({
      accountId: ACCOUNT_ID,
      applyControl: async (wire, _envelope, options) => {
        assert.equal(options?.deferPublish, true);
        assert.equal(options?.historyReplay, true);
        applied.push(wire.conversationSequence ?? 0);
      },
      flushCanonicalState: () => {
        events.push('flush');
        flushAfter.push(applied.length);
      },
      onSessionSettled: (sessionId) => events.push(`settled:${sessionId}`),
      shouldContinue: () => true,
    });

    assert.equal(recovered, true);
    assert.equal(native.pageRequests(), 4);
    assert.equal(applied[0], 102);
    assert.equal(applied.at(-1), 201);
    assert.deepEqual(
      new Set(applied.slice(0, -1)),
      new Set(Array.from({ length: 201 }, (_, index) => index + 1)),
    );
    assert.deepEqual(flushAfter, [100, 202]);
    assert.equal(events.at(-1), `settled:${SESSION_ID}`);
  } finally {
    native.restore();
  }
});

test('failed latest-page recovery never flushes or marks the session ready', async () => {
  const native = mockNativeHistory(
    Array.from({ length: 201 }, (_, index) => message(index + 1)),
  );
  let flushes = 0;
  let settled = 0;
  try {
    await assert.rejects(recoverNativeCloudGroupHistory({
      accountId: ACCOUNT_ID,
      applyControl: async (wire) => {
        if (wire.conversationSequence === 201) throw new Error('projection failed');
      },
      flushCanonicalState: () => { flushes += 1; },
      onSessionSettled: () => { settled += 1; },
      shouldContinue: () => true,
    }), /projection failed/);

    assert.equal(flushes, 0);
    assert.equal(settled, 0);
  } finally {
    native.restore();
  }
});

test('cancelled native recovery returns incomplete without publishing', async () => {
  const native = mockNativeHistory([message(1)]);
  let active = true;
  let applied = 0;
  let flushes = 0;
  let settled = 0;
  try {
    const recovered = await recoverNativeCloudGroupHistory({
      accountId: ACCOUNT_ID,
      applyControl: async () => {
        applied += 1;
        active = false;
      },
      flushCanonicalState: () => { flushes += 1; },
      onSessionSettled: () => { settled += 1; },
      shouldContinue: () => active,
    });

    assert.equal(recovered, false);
    assert.equal(applied, 1);
    assert.equal(flushes, 0);
    assert.equal(settled, 0);
  } finally {
    native.restore();
  }
});
