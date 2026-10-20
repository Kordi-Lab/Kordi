import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withoutStoredMessageRequests } from '../src/features/cloud/cloudSelfAgentCanonicalSyncExecution';
import { selfAgentAttachmentUpdate } from '../src/features/cloud/cloudSelfAgentAttachmentState';
import type { CloudSelfAgentCanonicalSyncPlan } from '../src/features/cloud/cloudSelfAgentCanonicalSync';
import type { CanonicalSessionMessage } from '../src/kordi-app/types';

const row: CanonicalSessionMessage = {
  id: 'msg:cloud:self:response:wire', sessionId: 's', senderIdentityId: 'agent:me', senderRole: 'owned-agent',
  messageKind: 'agent-turn', contentText: 'Done', content: { cloudRequestMessageId: 'wire', deliveryState: 'complete' },
  parentMessageId: 'msg:ui:request', delegatedExchangeId: null, status: 'complete', sequenceNum: 2,
  createdAtMs: 1001, updatedAtMs: 1001, sourceTransport: 'cloud-self-agent', sourceEventId: 'wire-response',
};
const request = {
  id: row.id, sessionId: row.sessionId, senderIdentityId: row.senderIdentityId, senderRole: row.senderRole,
  messageKind: row.messageKind, contentText: row.contentText, content: row.content, parentMessageId: row.parentMessageId,
  status: row.status, createdAtMs: row.createdAtMs, sourceTransport: row.sourceTransport, sourceEventId: row.sourceEventId,
};
const plan = (messageRequests: unknown[], mirrorReconciliations: unknown[] = []) => ({
  agentIdentityRequest: {}, sessionRequests: [], messageRequests, mirrorReconciliations,
}) as unknown as CloudSelfAgentCanonicalSyncPlan;

test('a sync plan does not rewrite rows that are already stored as planned', () => {
  assert.equal(withoutStoredMessageRequests(plan([request]), [row]).messageRequests.length, 0);
  const changed = { ...request, contentText: 'Done, with more' };
  assert.deepEqual(withoutStoredMessageRequests(plan([changed]), [row]).messageRequests, [changed]);
  const fresh = { ...request, id: 'msg:cloud:self:response:other' };
  assert.equal(withoutStoredMessageRequests(plan([fresh]), [row]).messageRequests.length, 1);
  const reconciled = plan([request], [{ preferredMessageId: row.id, duplicateMessageId: 'dup' }]);
  assert.equal(withoutStoredMessageRequests(reconciled, [row]).messageRequests.length, 1, 'a row in a reconciliation is still written');
});

test('a reply without attachments is not given an empty attachment list', () => {
  const message = { attachments: [], version: 3 } as never;
  assert.deepEqual(selfAgentAttachmentUpdate(message, { deliveryState: 'complete' }), { changed: false, content: { deliveryState: 'complete' } });
});
