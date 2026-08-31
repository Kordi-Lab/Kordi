import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CLOUD_MESSAGES_REFRESH_MS } from '../src/features/cloud/useCloudCollaborationState';
import {
  CLOUD_REALTIME_RECONNECT_MAX_MS,
  cloudRealtimeReconnectDelayMs,
  realtimeCallSyncEvent,
} from '../src/features/cloud/useCloudRealtimeMessages';

test('cloud bridge message polling is a low-frequency WebSocket repair path', () => {
  assert.equal(CLOUD_MESSAGES_REFRESH_MS, 15_000);
});

test('cloud realtime reconnect backs off and remains bounded', () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map(cloudRealtimeReconnectDelayMs),
    [1_000, 2_000, 4_000, 8_000, 15_000, 15_000],
  );
  assert.equal(cloudRealtimeReconnectDelayMs(100), CLOUD_REALTIME_RECONNECT_MAX_MS);
});

test('cloud realtime applies call lifecycle payloads before durable HTTP repair', () => {
  const event = realtimeCallSyncEvent({
    stream_seq: 42,
    event_id: 'event-call-updated',
    protocol_version: 2,
    type: 'call.updated',
    critical: true,
    conversation_id: 'conversation-1',
    entity_id: null,
    entity_version: null,
    occurred_at: '2026-08-31T16:00:00Z',
    payload: { call: { id: 'call-1', state: 'ended' } },
  });

  assert.equal(event?.eventType, 'call.updated');
  assert.deepEqual(event?.payload, {
    call: { id: 'call-1', state: 'ended' },
    sessionId: 'conversation-1',
  });
  assert.equal(realtimeCallSyncEvent({
    stream_seq: 43,
    event_id: 'event-message',
    protocol_version: 2,
    type: 'message.created',
    critical: true,
    conversation_id: 'conversation-1',
    entity_id: null,
    entity_version: null,
    occurred_at: '2026-08-31T16:00:01Z',
    payload: {},
  }), null);
});
