import assert from 'node:assert/strict';
import { test } from 'node:test';

import { shouldAppendOptimisticBridgeMessage } from '../src/features/chat/messageActions/chatMessages';

test('direct Cloud contact sends do not use generic Bridge optimistic rows', () => {
  assert.equal(shouldAppendOptimisticBridgeMessage('bridge:cloud:acct_peer:person'), false);
  assert.equal(shouldAppendOptimisticBridgeMessage('bridge:local:node_peer:person'), true);
});
