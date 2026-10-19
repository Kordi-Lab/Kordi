import assert from 'node:assert/strict';
import test from 'node:test';
import { backgroundFollowUpNoticeId } from '../src/features/cloud/cloudSelfAgentMirrorPlan';
import type { CanonicalSessionMessage } from '../src/kordi-app/types';

const notice = {
  id: 'msg:notice', sessionId: 'self-session', senderIdentityId: 'agent:self', senderRole: 'system',
  messageKind: 'system', contentText: 'Background session finished.', status: 'sent', sequenceNum: 3,
  createdAtMs: 3, updatedAtMs: 3, content: { desktopEntryId: 'background-result:child:done' },
} as CanonicalSessionMessage;

test('a background follow-up reply from Cloud is parented on its runtime notice', () => {
  assert.equal(backgroundFollowUpNoticeId([notice], 'self-session', 'background-result:child:done'), 'msg:notice');
});

test('ordinary requests and other sessions are not resolved as follow-ups', () => {
  assert.equal(backgroundFollowUpNoticeId([notice], 'self-session', 'cloud-request-id'), null);
  assert.equal(backgroundFollowUpNoticeId([notice], 'other-session', 'background-result:child:done'), null);
  assert.equal(backgroundFollowUpNoticeId([notice], 'self-session', 'background-result:other:done'), null);
});
