import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cloudSelfAgentResponseWouldDowngrade,
  shouldReplacePlannedCloudSelfAgentResponse,
} from '../src/features/cloud/cloudSelfAgentResponseLifecycle';

test('cancelled and completed self-agent turns are terminal lifecycle states', () => {
  assert.equal(cloudSelfAgentResponseWouldDowngrade('cancelled', 'complete'), true);
  assert.equal(shouldReplacePlannedCloudSelfAgentResponse('cancelled', 'complete'), false);
  assert.equal(cloudSelfAgentResponseWouldDowngrade('complete', 'processing'), true);
  assert.equal(shouldReplacePlannedCloudSelfAgentResponse('complete', 'processing'), false);
});

test('a successful repair may replace a failed fallback exactly once', () => {
  assert.equal(cloudSelfAgentResponseWouldDowngrade('failed', 'complete'), false);
  assert.equal(shouldReplacePlannedCloudSelfAgentResponse('failed', 'complete'), true);
  assert.equal(cloudSelfAgentResponseWouldDowngrade('complete', 'failed'), true);
});
