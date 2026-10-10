import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudMessage } from '../src/features/cloud/authClient';
import { parseCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { publishCloudSelfAgentOperations } from '../src/features/cloud/cloudSelfAgentForwardExecution';
import { planCloudSelfAgentSync } from '../src/features/cloud/useCloudCollaborationState';
import type { CanonicalSessionMessage, CanonicalSessionState } from '../src/kordi-app/types';

test('a background follow-up reply is published under its own request id, without the runtime notice', () => {
  const sessionId = 'session:self-agent:shared';
  const state = {
    sessions: [
      { id: sessionId, kind: 'self-agent', title: 'Shared', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'agent:me', createdAtMs: 1, updatedAtMs: 1 },
    ],
    identities: [],
    participants: [],
    profile: { id: 'profile', storageRoot: '/tmp/device-a', createdAtMs: 1, updatedAtMs: 1 },
    messages: [
      { id: 'local-request', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'Count lines in the background', content: {}, parentMessageId: null, status: 'sent', sequenceNum: 1, createdAtMs: 10, updatedAtMs: 10 },
      { id: 'local-response', sessionId, senderIdentityId: 'agent:me', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'Started the background task.', content: { replyToMessageId: 'local-request', deliveryState: 'complete' }, parentMessageId: 'local-request', status: 'complete', sequenceNum: 2, createdAtMs: 20, updatedAtMs: 20 },
      { id: 'local-notice', sessionId, senderIdentityId: 'agent:me', senderRole: 'system', messageKind: 'system', contentText: 'Background session "Count lines" finished.', content: { desktopEntryId: 'background-result:child:done' }, parentMessageId: null, status: 'sent', sequenceNum: 3, createdAtMs: 30, updatedAtMs: 30 },
      { id: 'local-follow-up', sessionId, senderIdentityId: 'agent:me', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'The project has 1,204 lines.', content: { replyToMessageId: 'local-notice', deliveryState: 'complete' }, parentMessageId: 'local-notice', status: 'complete', sequenceNum: 4, createdAtMs: 40, updatedAtMs: 40 },
    ] as CanonicalSessionMessage[],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
    storagePath: '/tmp/device-a/canonical.sqlite3',
  } as CanonicalSessionState;

  const operations = planCloudSelfAgentSync(state, {});
  assert.deepEqual(operations.map((operation) => operation.localMessageId), ['local-request', 'local-response', 'local-follow-up']);
  assert.equal(operations[1]?.requestId, undefined);
  assert.equal(operations[2]?.parentLocalMessageId, 'local-notice');
  assert.equal(operations[2]?.requestId, 'background-result:child:done');
});

test('a background follow-up reply publishes without a forwarded parent request', async () => {
  const sent: string[] = [];
  await publishCloudSelfAgentOperations({
    accountId: 'acct_me',
    token: 'token',
    ledger: {},
    saveLedger: () => undefined,
    mergeMessage: () => undefined,
    client: {
      sendMessage: async (_token: string, _peer: string, body: string) => {
        sent.push(body);
        return { messageId: `wire-${sent.length}`, fromAccountId: 'acct_me', toAccountId: 'acct_me', body, createdAt: '', deliveredAt: null, readAt: null } as CloudMessage;
      },
    },
    operations: [{
      localMessageId: 'local-follow-up', sessionId: 'session:self-agent:shared', role: 'agent', text: 'The project has 1,204 lines.',
      parentLocalMessageId: 'local-notice', createdAtMs: 40, deliveryState: 'complete', requestId: 'background-result:child:done',
    }],
  });
  assert.equal(sent.length, 1);
  assert.equal(parseCloudAgentResponse(sent[0] ?? '')?.requestId, 'background-result:child:done');
});
