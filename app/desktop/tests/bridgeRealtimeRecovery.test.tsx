import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BRIDGE_REALTIME_RECOVERY_THROTTLE_MS,
  shouldRefreshBridgeRealtimeForVisibility,
  shouldRunBridgeRealtimeRecovery,
} from '../src/features/bridge/realtimeRecovery';

test('visible document state should trigger Bridge realtime recovery', () => {
  assert.equal(shouldRefreshBridgeRealtimeForVisibility('visible'), true);
  assert.equal(shouldRefreshBridgeRealtimeForVisibility('hidden'), false);
});

test('Bridge realtime recovery is throttled across focus and visibility bursts', () => {
  assert.equal(shouldRunBridgeRealtimeRecovery(10_000, 0), true);
  assert.equal(shouldRunBridgeRealtimeRecovery(10_000, 10_000), false);
  assert.equal(
    shouldRunBridgeRealtimeRecovery(
      10_000 + BRIDGE_REALTIME_RECOVERY_THROTTLE_MS,
      10_000,
    ),
    true,
  );
});
