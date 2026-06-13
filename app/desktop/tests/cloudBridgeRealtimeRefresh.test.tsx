import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CLOUD_MESSAGES_REFRESH_MS } from '../src/features/cloud/useCloudBridgeState';

test('cloud bridge message refresh fallback is paced to avoid WebKit CPU churn', () => {
  assert.equal(CLOUD_MESSAGES_REFRESH_MS, 5_000);
});
