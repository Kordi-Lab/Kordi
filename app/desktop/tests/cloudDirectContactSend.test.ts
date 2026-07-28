import assert from 'node:assert/strict';
import { test } from 'node:test';

import { shouldAppendOptimisticCollaborationMessage } from '../src/features/chat/messageActions/chatMessages';
import { cloudSessionIdForCollaborationSend } from '../src/features/cloud/cloudCollaborationState';

test('direct Cloud contact sends use an optimistic row so attachments preview immediately', () => {
  assert.equal(shouldAppendOptimisticCollaborationMessage('bridge:cloud:acct_peer:person'), true);
  assert.equal(shouldAppendOptimisticCollaborationMessage('bridge:local:node_peer:person'), true);
});

test('direct Cloud contact sends include stable Cloud session id', () => {
  assert.equal(
    cloudSessionIdForCollaborationSend('acct_me', 'acct_peer', 'bridge:cloud:acct_peer:person'),
    'session:direct-person:acct_me:acct_peer',
  );
  assert.equal(
    cloudSessionIdForCollaborationSend('acct_peer', 'acct_me', 'bridge:cloud:acct_me:person'),
    'session:direct-person:acct_me:acct_peer',
  );
});
