import assert from 'node:assert/strict';
import { test } from 'node:test';

import { shouldShowBridgeMailboxPollProgress } from '../src/features/bridge/useBridgeState';

test('routine Bridge mailbox polling stays silent while catch-up polls surface progress', () => {
  assert.equal(shouldShowBridgeMailboxPollProgress('startup', 20_000, 0), true);
  assert.equal(shouldShowBridgeMailboxPollProgress('focus', 20_000, 0), true);
  assert.equal(shouldShowBridgeMailboxPollProgress('pageshow', 20_000, 0), true);
  assert.equal(shouldShowBridgeMailboxPollProgress('visibilitychange', 20_000, 0), true);
  assert.equal(shouldShowBridgeMailboxPollProgress('routine', 20_000, 0), false);
});

test('Bridge mailbox catch-up progress has a cooldown to avoid repeated focus flashes', () => {
  assert.equal(shouldShowBridgeMailboxPollProgress('focus', 25_000, 20_000), false);
  assert.equal(shouldShowBridgeMailboxPollProgress('focus', 36_000, 20_000), true);
});
