import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CLOUD_MESSAGES_REFRESH_MS } from '../src/features/cloud/useCloudCollaborationState';

test('cloud bridge message refresh fallback is near realtime', () => {
  assert.equal(CLOUD_MESSAGES_REFRESH_MS, 500);
});
