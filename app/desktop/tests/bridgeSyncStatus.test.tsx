import assert from 'node:assert/strict';
import { test } from 'node:test';

import { shouldShowBridgeMailboxPollProgress } from '../src/features/bridge/useBridgeState';

test('routine Bridge mailbox polling stays silent while catch-up polls surface progress', () => {
  assert.equal(shouldShowBridgeMailboxPollProgress('startup'), true);
  assert.equal(shouldShowBridgeMailboxPollProgress('focus'), true);
  assert.equal(shouldShowBridgeMailboxPollProgress('pageshow'), true);
  assert.equal(shouldShowBridgeMailboxPollProgress('visibilitychange'), true);
  assert.equal(shouldShowBridgeMailboxPollProgress('routine'), false);
});
