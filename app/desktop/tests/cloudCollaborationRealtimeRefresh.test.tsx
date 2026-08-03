import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CLOUD_MESSAGES_REFRESH_MS } from '../src/features/cloud/useCloudCollaborationState';
import {
  CLOUD_REALTIME_RECONNECT_MAX_MS,
  cloudRealtimeReconnectDelayMs,
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
