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

test('realtime arrival frames request authoritative cursor sync', () => {
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
    { kind: 'refresh' },
  );
});

test('transactional outbox frames request authoritative cursor sync', () => {
  assert.deepEqual(
    decodeCloudRealtimeMessageFrame(
      JSON.stringify({
        subject: 'kordi.events.sync.changed.acct_self',
        payload: {
          event_type: 'sync.changed',
          event_id: '42',
        },
      }),
      'acct_self',
    ),
    { kind: 'refresh' },
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
  assert.throws(
    () => decodeCloudRealtimeMessageFrame('not-json', 'acct_self'),
    SyntaxError,
  );
});
