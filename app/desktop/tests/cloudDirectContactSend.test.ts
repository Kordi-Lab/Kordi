import assert from 'node:assert/strict';
import { test } from 'node:test';

import { shouldAppendOptimisticBridgeMessage } from '../src/features/chat/messageActions/chatMessages';
import { cloudSessionIdForBridgeSend } from '../src/features/cloud/cloudBridgeState';

test('direct Cloud contact sends use an optimistic row so attachments preview immediately', () => {
  assert.equal(shouldAppendOptimisticBridgeMessage('bridge:cloud:acct_peer:person'), true);
  assert.equal(shouldAppendOptimisticBridgeMessage('bridge:local:node_peer:person'), true);
});

test('direct Cloud contact sends include stable Cloud session id', () => {
  assert.equal(
    cloudSessionIdForBridgeSend('acct_me', 'acct_peer', 'bridge:cloud:acct_peer:person'),
    'session:direct-person:acct_me:acct_peer',
  );
  assert.equal(
    cloudSessionIdForBridgeSend('acct_peer', 'acct_me', 'bridge:cloud:acct_me:person'),
    'session:direct-person:acct_me:acct_peer',
  );
});
