import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import {
  applyChatSyncLocalBatch,
  CHAT_SYNC_LOCAL_STATE_CHANGED_EVENT,
  type ApplyChatSyncRequest,
  type ChatSyncApplyResult,
} from '../src/lib/desktopChatSync';

test('cursor-only commits persist without waking unread projections; changed batches still publish', async () => {
  const previous = globalThis.window;
  Object.assign(globalThis, { window: new EventTarget() });
  let commits = 0;
  let refreshes = 0;
  const result: ChatSyncApplyResult = {
    accountId: 'fixture-account', cursor: 'next-cursor', lastStreamSeq: 2, changedConversationHeads: [],
  };
  mockIPC((command) => {
    assert.equal(command, 'desktop_chat_sync_apply');
    commits += 1;
    return result;
  });
  window.addEventListener(CHAT_SYNC_LOCAL_STATE_CHANGED_EVENT, () => { refreshes += 1; });
  const empty: ApplyChatSyncRequest = {
    accountId: result.accountId, bootstrap: false, cursor: result.cursor, lastStreamSeq: 2,
    conversations: [], messages: [], events: [],
  };
  try {
    assert.equal(await applyChatSyncLocalBatch(empty), result);
    assert.equal(commits, 1);
    assert.equal(refreshes, 0);
    await applyChatSyncLocalBatch({ ...empty, bootstrap: true });
    await applyChatSyncLocalBatch({ ...empty, events: [{
      event_id: 'fixture-event', type: 'message.deleted', stream_seq: 3, protocol_version: 2,
      critical: true, conversation_id: 'fixture-conversation', entity_id: 'fixture-message',
      entity_version: 2, occurred_at: '2026-09-11T00:00:00Z', payload: {},
    }] });
    result.changedConversationHeads.push({
      conversationId: 'fixture-conversation', sessionId: 'fixture-session', latestMessageSequence: 2,
      lastReadSequence: 1, unreadCount: 1,
    });
    await applyChatSyncLocalBatch(empty);
    assert.equal(commits, 4);
    assert.equal(refreshes, 3);
  } finally {
    clearMocks();
    Object.assign(globalThis, { window: previous });
  }
});
