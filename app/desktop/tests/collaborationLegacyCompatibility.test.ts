import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compatibleSourceConversationId,
  compatibleSourceHostId,
  compatibleSourceIdentityId,
  compatibleSourceRequestId,
  normalizeCollaborationTargetKind,
} from '../src/features/collaboration/legacyBridgeCompatibility';

test('legacy Bridge-shaped fields remain readable through the compatibility boundary', () => {
  const legacy = {
    bridgeHostId: 'cloud',
    bridgeNodeId: 'acct_legacy',
    bridgeConversationId: 'conversation:legacy',
    bridgeRequestId: 'request:legacy',
  };

  assert.equal(compatibleSourceHostId(legacy), 'cloud');
  assert.equal(compatibleSourceIdentityId(legacy), 'acct_legacy');
  assert.equal(compatibleSourceConversationId(legacy), 'conversation:legacy');
  assert.equal(compatibleSourceRequestId(legacy), 'request:legacy');
  assert.equal(normalizeCollaborationTargetKind('bridge-agent'), 'agent');
  assert.equal(normalizeCollaborationTargetKind('bridge-person'), 'person');
});

test('neutral source fields take precedence and neutral target kinds pass through', () => {
  const mixed = {
    sourceHostId: 'current-host',
    bridgeHostId: 'legacy-host',
    sourceIdentityId: 'current-identity',
    bridgeNodeId: 'legacy-identity',
    sourceConversationId: 'current-conversation',
    bridgeConversationId: 'legacy-conversation',
    sourceRequestId: 'current-request',
    bridgeRequestId: 'legacy-request',
  };

  assert.equal(compatibleSourceHostId(mixed), 'current-host');
  assert.equal(compatibleSourceIdentityId(mixed), 'current-identity');
  assert.equal(compatibleSourceConversationId(mixed), 'current-conversation');
  assert.equal(compatibleSourceRequestId(mixed), 'current-request');
  assert.equal(normalizeCollaborationTargetKind('agent'), 'agent');
  assert.equal(normalizeCollaborationTargetKind('person'), 'person');
});
