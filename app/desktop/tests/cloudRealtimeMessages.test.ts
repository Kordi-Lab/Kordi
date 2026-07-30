import {
  strict as assert,
} from 'node:assert';
import test from 'node:test';
import {
  decodeCloudRealtimeMessageFrame,
} from '../src/features/cloud/cloudRealtimeMessages';

test('realtime read frames request a Cloud refresh', () => {
  assert.deepEqual(
    decodeCloudRealtimeMessageFrame(
      JSON.stringify({
        subject: 'kordi.events.message.read.acct_self',
      }),
      'acct_self',
    ),
    { kind: 'refresh' },
  );
});

test('realtime arrival frames preserve message metadata and direction', () => {
  assert.deepEqual(
    decodeCloudRealtimeMessageFrame(
      JSON.stringify({
        subject: 'kordi.events.message.arrived.acct_self',
        payload: {
          message_id: 'msg_1',
          from_account_id: 'acct_peer',
          to_account_id: 'acct_self',
          body: 'hello',
          created_at: '2026-07-29T12:00:00Z',
          delivered_at: '2026-07-29T12:00:01Z',
          read_at: null,
          session_id: 'session_1',
        },
      }),
      'acct_self',
    ),
    {
      kind: 'message',
      message: {
        messageId: 'msg_1',
        fromAccountId: 'acct_peer',
        toAccountId: 'acct_self',
        body: 'hello',
        createdAt: '2026-07-29T12:00:00Z',
        deliveredAt: '2026-07-29T12:00:01Z',
        readAt: null,
        direction: 'incoming',
        sessionId: 'session_1',
      },
    },
  );
});

test('realtime decoder ignores unrelated and incomplete frames', () => {
  assert.equal(
    decodeCloudRealtimeMessageFrame(
      JSON.stringify({ subject: 'kordi.events.presence.changed' }),
      'acct_self',
    ),
    null,
  );
  assert.equal(
    decodeCloudRealtimeMessageFrame(
      JSON.stringify({
        subject: 'kordi.events.message.arrived.acct_self',
        payload: { from_account_id: 'acct_peer' },
      }),
      'acct_self',
    ),
    null,
  );
  assert.throws(
    () => decodeCloudRealtimeMessageFrame('not-json', 'acct_self'),
    SyntaxError,
  );
});
