import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cloudDirectMessageDisplayText,
  encodeCloudDirectMessageEnvelope,
  parseCloudDirectMessageEnvelope,
} from '../src/features/cloud/cloudDirectMessages';
import { quoteMessageAction } from '../src/features/chat/messageActionMetadata';

const source = {
  sourceSessionId: 'session:one',
  sourceMessageId: 'msg:source',
  senderLabel: 'Alice',
  textPreview: 'Original',
  attachmentCount: 0,
};

test('direct cloud envelopes preserve display text and quote metadata', () => {
  const encoded = encodeCloudDirectMessageEnvelope({
    schemaVersion: 1,
    kind: 'message',
    text: 'Replying with context',
    messageAction: quoteMessageAction(source),
  });

  assert.equal(cloudDirectMessageDisplayText(encoded), 'Replying with context');
  assert.equal(parseCloudDirectMessageEnvelope(encoded)?.messageAction?.kind, 'quote');
  assert.equal(parseCloudDirectMessageEnvelope(encoded)?.messageAction?.source.sourceMessageId, 'msg:source');
});

test('direct cloud display text falls back to plaintext bodies', () => {
  assert.equal(parseCloudDirectMessageEnvelope('plain body'), null);
  assert.equal(cloudDirectMessageDisplayText('plain body'), 'plain body');
});
