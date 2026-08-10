import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cloudAgentCancelOperationId,
  cloudAgentResponseOperationId,
  cloudMessageRecipientOperationId,
  createCloudMessageOperationId,
} from '../src/features/cloud/cloudMessageLifecycle';

test('message operation ids are unique per producer operation', () => {
  const first = createCloudMessageOperationId('direct user');
  const second = createCloudMessageOperationId('direct user');
  assert.match(first, /^kordi-message-v2:direct-user:/);
  assert.notEqual(first, second);
});

test('derived lifecycle ids are stable for retries and scoped per recipient', () => {
  assert.equal(
    cloudAgentResponseOperationId('msg_request'),
    cloudAgentResponseOperationId('msg_request'),
  );
  assert.equal(
    cloudAgentCancelOperationId('msg_request'),
    cloudAgentCancelOperationId('msg_request'),
  );
  assert.notEqual(
    cloudMessageRecipientOperationId('operation', 'acct_a'),
    cloudMessageRecipientOperationId('operation', 'acct_b'),
  );
});
