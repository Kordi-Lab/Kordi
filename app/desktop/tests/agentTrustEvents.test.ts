import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_ACTION_UPDATED_EVENT,
  AI_ACCESS_UPDATED_EVENT,
  type AgentActionUpdatedDetail,
  type AiAccessUpdatedDetail,
} from '../src/features/agentTrust/agentTrustEvents';
import { ChatSyncState } from '../src/features/cloud/chatSyncState';
import { ChatSyncSyncClient } from '../src/features/cloud/chatSyncSyncClient';
import type { ChatSyncConversation, ChatSyncEvent, ChatSyncSyncResponse } from '../src/features/cloud/chatSyncTypes';

const conversation: ChatSyncConversation = {
  id: 'conversation-trust',
  kind: 'group',
  shared_title: 'Weekend',
  version: 3,
  created_by_account_id: 'acct_owner',
  legacy_session_id: 'session:group:trust',
  latest_message_sequence: 4,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  members: [],
  preferences: { conversation_id: 'conversation-trust', account_id: 'acct_viewer', personal_title: null, version: 1 },
  ai_access: {
    history_scope: 'mentions',
    pip: { available: true, enabled: false, provider_label: 'OpenAI' },
    excluded_member_ids: ['acct_c'],
    viewer_excluded: false,
    viewer_can_manage: true,
  },
};

function chatEvent(type: string, payload: Record<string, unknown>): ChatSyncEvent {
  return {
    stream_seq: 7,
    event_id: `event-${type}`,
    protocol_version: 2,
    type,
    critical: false,
    conversation_id: conversation.id,
    entity_id: null,
    entity_version: null,
    occurred_at: '2026-10-01T00:00:00Z',
    payload,
  };
}

async function sync(events: ChatSyncEvent[]) {
  const response = {
    protocol_version: 2,
    events,
    next_cursor: '7',
    last_stream_seq: 7,
    has_more: false,
    server_time: '2026-10-01T00:00:00Z',
  } satisfies ChatSyncSyncResponse;
  const state = new ChatSyncState(async () => response, () => 'acct_viewer', () => undefined, () => null);
  return new ChatSyncSyncClient(state).syncCloudEvents('token', '6');
}

function captureWindowEvents<T>(name: string) {
  const target = new EventTarget();
  const received: T[] = [];
  target.addEventListener(name, (event) => received.push((event as CustomEvent<T>).detail));
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: target });
  return {
    received,
    restore() {
      if (previous) Object.defineProperty(globalThis, 'window', previous);
      else delete (globalThis as Record<string, unknown>).window;
    },
  };
}

test('agent_action.updated reaches open views and adds no chat sync events', async () => {
  const capture = captureWindowEvents<AgentActionUpdatedDetail>(AGENT_ACTION_UPDATED_EVENT);
  try {
    const result = await sync([chatEvent('agent_action.updated', {
      agentAction: {
        actionId: 'action-1',
        kind: 'calendar_disclosure',
        sessionId: 'session:group:trust',
        conversationId: conversation.id,
        status: 'pending',
        createdAt: '2026-10-01T00:00:00Z',
        expiresAt: '2026-10-01T00:10:00Z',
        proposedBy: { accountId: 'acct_owner', displayName: 'Scout', kind: 'agent' },
        subject: { agentName: 'Scout', startAt: null, endAt: null },
      },
    })]);
    assert.deepEqual(result.events, []);
    assert.equal(capture.received.length, 1);
    assert.equal(capture.received[0]?.action?.actionId, 'action-1');
    assert.equal(capture.received[0]?.action?.kind, 'calendar_disclosure');
  } finally {
    capture.restore();
  }
});

test('a malformed agent action still notifies without breaking sync', async () => {
  const capture = captureWindowEvents<AgentActionUpdatedDetail>(AGENT_ACTION_UPDATED_EVENT);
  try {
    const result = await sync([chatEvent('agent_action.updated', { agentAction: { kind: 'unknown' } })]);
    assert.deepEqual(result.events, []);
    assert.deepEqual(capture.received, [{ action: null }]);
  } finally {
    capture.restore();
  }
});

test('conversation and membership updates announce AI access by session id', async () => {
  const capture = captureWindowEvents<AiAccessUpdatedDetail>(AI_ACCESS_UPDATED_EVENT);
  try {
    const result = await sync([
      chatEvent('conversation.updated', { conversation }),
      chatEvent('membership.updated', { conversation: { ...conversation, version: 4 } }),
    ]);
    assert.deepEqual(result.events.map((event) => event.eventType), ['session.title.updated', 'session.title.updated']);
    assert.equal(capture.received.length, 2);
    assert.equal(capture.received[0]?.sessionId, 'session:group:trust');
    assert.deepEqual(capture.received[0]?.aiAccess?.excluded_member_ids, ['acct_c']);
  } finally {
    capture.restore();
  }
});

test('snapshots from servers without AI access settings announce nothing', async () => {
  const capture = captureWindowEvents<AiAccessUpdatedDetail>(AI_ACCESS_UPDATED_EVENT);
  try {
    const legacy = { ...conversation };
    delete legacy.ai_access;
    await sync([chatEvent('conversation.updated', { conversation: legacy })]);
    assert.equal(capture.received.length, 0);
  } finally {
    capture.restore();
  }
});
