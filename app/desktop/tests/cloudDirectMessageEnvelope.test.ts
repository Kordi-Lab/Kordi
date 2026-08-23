import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cloudDirectMessageDisplayText,
  cloudDirectMessageMentions,
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

test('direct cloud envelopes preserve hosted Cloud Agent target metadata', () => {
  const encoded = encodeCloudDirectMessageEnvelope({
    schemaVersion: 1,
    kind: 'message',
    text: '@KordiProjectDriver hi',
    targetCloudAgentId: 'cloud_agent_project',
    targetCloudAgentName: 'Kordi Project Driver',
    targetCloudAgentOwnerAccountId: 'acct_owner',
    targetCloudAgentOwnerName: '111',
  });

  const parsed = parseCloudDirectMessageEnvelope(encoded);
  assert.equal(parsed?.targetCloudAgentId, 'cloud_agent_project');
  assert.equal(parsed?.targetCloudAgentName, 'Kordi Project Driver');
  assert.equal(parsed?.targetCloudAgentOwnerAccountId, 'acct_owner');
  assert.equal(parsed?.targetCloudAgentOwnerName, '111');
  assert.equal(cloudDirectMessageDisplayText(encoded), '@KordiProjectDriver hi');
});

test('direct cloud envelopes preserve stable mention identity and exact display range', () => {
  const displayText = "@Alex Smith’s Kordi";
  const encoded = encodeCloudDirectMessageEnvelope({
    schemaVersion: 1,
    kind: 'message',
    text: `${displayText} please review`,
    mentions: [{
      label: 'AlexSmithsKordi',
      targetKind: 'agent',
      targetIdentityId: 'agent:cloud_agent_alex',
      startUtf16: 0,
      lengthUtf16: displayText.length,
      displayText,
    }],
  });

  assert.deepEqual(cloudDirectMessageMentions(encoded), [{
    label: 'AlexSmithsKordi',
    targetKind: 'agent',
    targetIdentityId: 'agent:cloud_agent_alex',
    startUtf16: 0,
    lengthUtf16: displayText.length,
    displayText,
    sourceHostId: null,
    nodeId: null,
    humanId: null,
    agentId: null,
    displayLabel: null,
  }]);
});

test('direct cloud display text falls back to plaintext bodies', () => {
  assert.equal(parseCloudDirectMessageEnvelope('plain body'), null);
  assert.equal(cloudDirectMessageDisplayText('plain body'), 'plain body');
});
