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

function messageIn(conversationId: string, sessionId: string, sequence: number): ChatSyncMessage {
  const createdAt = `2026-08-28T00:${String(Math.floor(sequence / 60)).padStart(2, '0')}:${String(sequence % 60).padStart(2, '0')}Z`;
  const body = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: sessionId,
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
      id: `canonical-${conversationId}-${sequence}`,
      senderAccountId: 'acct_peer',
      senderKind: 'human',
      senderDisplayName: 'Peer',
      text: `Message ${sequence}`,
      createdAtMs: Date.parse(createdAt),
    },
  });
  return {
    id: `wire-${conversationId}-${sequence}`,
    client_message_id: `client-${conversationId}-${sequence}`,
    conversation_id: conversationId,
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

function message(sequence: number): ChatSyncMessage {
  return messageIn(CONVERSATION_ID, SESSION_ID, sequence);
}

function mockNativeHistory(messages: ChatSyncMessage[]) {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {},
  });
  let pageRequests = 0;
  mockIPC((command, payload) => {
    if (command === 'desktop_chat_sync_cursor') {
      return { accountId: ACCOUNT_ID, cursor: 'cursor-1', lastStreamSeq: 1 };
    }
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

function mockNativeStore(options: {
  bootstrapped: () => boolean;
  conversations: () => ChatSyncConversation[];
  messagesByConversation: Map<string, ChatSyncMessage[]>;
  onPage?: (conversationId: string) => void;
}) {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {},
  });
  let cursorPolls = 0;
  mockIPC((command, payload) => {
    if (command === 'desktop_chat_sync_cursor') {
      cursorPolls += 1;
      return options.bootstrapped()
        ? { accountId: ACCOUNT_ID, cursor: 'cursor-1', lastStreamSeq: 1 }
        : { accountId: ACCOUNT_ID, cursor: null, lastStreamSeq: 0 };
    }
    if (command === 'desktop_chat_sync_conversations') return options.conversations();
    if (command === 'desktop_chat_sync_coverage') {
      return options.conversations().map((entry) => {
        const messages = options.messagesByConversation.get(entry.id) ?? [];
        return {
          conversationId: entry.id,
          earliestSequence: messages.length > 0 ? 1 : 0,
          latestSequence: messages.length,
          messageCount: messages.length,
        };
      });
    }
    if (command === 'desktop_canonical_existing_message_sources') return [];
    if (command !== 'desktop_chat_sync_messages_page') {
      throw new Error(`Unexpected native command: ${command}`);
    }
    const conversationId = String(payload?.conversationId ?? '');
    options.onPage?.(conversationId);
    const messages = options.messagesByConversation.get(conversationId) ?? [];
    const afterSequence = Number(payload?.afterSequence ?? 0);
    const pageMessages = messages.slice(afterSequence, afterSequence + 100);
    return {
      conversationId,
      messages: pageMessages,
      nextAfterSequence: pageMessages.at(-1)?.conversation_sequence ?? null,
      hasMore: afterSequence + pageMessages.length < messages.length,
    };
  });
  return {
    cursorPolls: () => cursorPolls,
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

test('recovery started before the first sync batch waits for it instead of reporting success', async () => {
  // A fresh profile starts recovery as soon as it signs in, before sync has
  // written anything. With one recovery per context, an empty first pass
  // that reported success would leave the account without group history.
  let bootstrapped = false;
  const messages = Array.from({ length: 3 }, (_, index) => message(index + 1));
  const native = mockNativeStore({
    bootstrapped: () => bootstrapped,
    conversations: () => (
      bootstrapped ? [{ ...conversation, latest_message_sequence: messages.length }] : []
    ),
    messagesByConversation: new Map([[CONVERSATION_ID, messages]]),
  });
  const applied: number[] = [];
  const settled: string[] = [];
  try {
    const recovery = recoverNativeCloudGroupHistory({
      accountId: ACCOUNT_ID,
      applyControl: async (wire) => {
        applied.push(wire.conversationSequence ?? 0);
      },
      flushCanonicalState: () => {},
      onSessionSettled: (sessionId) => settled.push(sessionId),
      shouldContinue: () => true,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(applied, [], 'nothing can be applied before the first batch lands');
    assert.deepEqual(settled, [], 'no session may settle before the first batch lands');
    bootstrapped = true;

    assert.equal(await recovery, true);
    assert.deepEqual(applied, [1, 2, 3]);
    assert.deepEqual(settled, [SESSION_ID]);
    assert.ok(native.cursorPolls() >= 2, 'recovery must poll the cursor until sync lands');
  } finally {
    native.restore();
  }
});

test('a group that lands while recovery runs is recovered before completion is reported', async () => {
  // Sync writes conversations in pages, so a group can appear after the
  // initial snapshot. It must still get its full latest page, head included.
  const lateConversationId = 'conversation-group-late';
  const lateSessionId = 'session:group:late';
  const first = Array.from({ length: 2 }, (_, index) => message(index + 1));
  const late = Array.from({ length: 2 }, (_, index) => messageIn(lateConversationId, lateSessionId, index + 1));
  let landed = false;
  const native = mockNativeStore({
    bootstrapped: () => true,
    conversations: () => [
      { ...conversation, latest_message_sequence: first.length },
      ...(landed ? [{
        ...conversation,
        id: lateConversationId,
        legacy_session_id: lateSessionId,
        latest_message_sequence: late.length,
        preferences: { ...conversation.preferences, conversation_id: lateConversationId },
      }] : []),
    ],
    messagesByConversation: new Map([[CONVERSATION_ID, first], [lateConversationId, late]]),
    onPage: (conversationId) => {
      if (conversationId === CONVERSATION_ID) landed = true;
    },
  });
  const applied: string[] = [];
  const settled: string[] = [];
  try {
    const recovered = await recoverNativeCloudGroupHistory({
      accountId: ACCOUNT_ID,
      applyControl: async (wire) => {
        applied.push(`${wire.conversationId ?? ''}:${wire.conversationSequence ?? 0}`);
      },
      flushCanonicalState: () => {},
      onSessionSettled: (sessionId) => settled.push(sessionId),
      shouldContinue: () => true,
    });

    assert.equal(recovered, true);
    assert.deepEqual(
      applied.filter((entry) => entry.startsWith(`${lateConversationId}:`)),
      [`${lateConversationId}:1`, `${lateConversationId}:2`],
      'the late group must receive its whole latest page, including the head',
    );
    assert.deepEqual(new Set(settled), new Set([SESSION_ID, lateSessionId]));
  } finally {
    native.restore();
  }
});
