import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CLOUD_MESSAGES_REFRESH_MS } from '../src/features/cloud/useCloudBridgeState';

test('cloud bridge message refresh fallback avoids subsecond full-state churn', () => {
  assert.equal(CLOUD_MESSAGES_REFRESH_MS, 2_000);
});
