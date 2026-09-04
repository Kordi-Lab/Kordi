import assert from 'node:assert/strict';
import test from 'node:test';

import { chatSyncHistoryIsComplete } from '../src/lib/desktopChatSync';

function conversation(lastDeliveredSequence: number) {
  return {
    id: 'conversation-1',
    latest_message_sequence: 5,
    preferences: { account_id: 'acct_me' },
    members: [{ account_id: 'acct_me', last_delivered_sequence: lastDeliveredSequence }],
  } as never;
}

test('delivery cursor completes history even when deleted messages leave sequence gaps', () => {
  const gapCoverage = [{
    conversationId: 'conversation-1',
    earliestSequence: 2,
    latestSequence: 2,
    messageCount: 1,
  }];

  assert.equal(chatSyncHistoryIsComplete([conversation(5)], gapCoverage), true);
  assert.equal(chatSyncHistoryIsComplete([conversation(4)], gapCoverage), false);
});
