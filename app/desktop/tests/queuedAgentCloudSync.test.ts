import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanonicalSessionMessage, CanonicalSessionState, QueuedDesktopChatMessage } from '../src/kordi-app/types';
import type { CloudMessage } from '../src/features/cloud/authClient';
import { prepareCanonicalQueuedMessage } from '../src/features/chat/messageActions/optimistic';
import { localSelfAgentRequestCanPublishExecution } from '../src/features/cloud/cloudSelfAgentForwardPolicy';
import { planCloudSelfAgentSync, type CloudSelfAgentSyncLedger, type CloudSelfAgentSyncOperation } from '../src/features/cloud/cloudSelfAgentForwardSync';
import { publishCloudSelfAgentOperations } from '../src/features/cloud/cloudSelfAgentForwardExecution';
import { parseCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { cloudSelfAgentForwardMessageKind } from '../src/features/cloud/cloudSelfAgentForwardPolicy';
import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';

const queued: QueuedDesktopChatMessage = {
  id: 'queued-local-chat:session:request-b', sessionId: 'session', scope: 'chat',
  text: 'QUEUE-B complete', time: '12:00', createdAtMs: 1000, attachments: [],
};

function stateFor(status: 'queued' | 'sent' | 'cancelled'): CanonicalSessionState {
  const prepared = prepareCanonicalQueuedMessage(queued, 'human', status)!;
  return {
    storagePath: '/tmp/queue-test.sqlite',
    profile: { id: 'profile', storageRoot: '/tmp', humanIdentityId: 'human', createdAtMs: 1, updatedAtMs: 1 },
    identities: [], participants: [], delegatedExchanges: [], presence: [], contextSnapshots: [],
    sessions: [{ id: 'session', kind: 'self-agent', title: 'Agent', status: 'active', createdByIdentityId: 'human', createdAtMs: 1, updatedAtMs: 1 }],
    messages: [{ ...prepared.request, id: prepared.messageId, sequenceNum: 1, updatedAtMs: 1000 } as CanonicalSessionMessage],
  };
}

function publisher() {
  const messages = new Map<string, CloudMessage>();
  const ledger: CloudSelfAgentSyncLedger = {};
  const client = {
    async sendMessage(_token: string, accountId: string, body: string, options: { sessionId?: string | null; clientMessageId?: string | null }) {
      const key = options.clientMessageId!;
      if (messages.has(key)) return messages.get(key)!;
      const message: CloudMessage = {
        messageId: `cloud-${messages.size + 1}`, fromAccountId: accountId, toAccountId: accountId,
        body, createdAt: '2026-09-05T00:00:00Z', deliveredAt: null, readAt: null, sessionId: options.sessionId,
      };
      messages.set(key, message);
      return message;
    },
  };
  return {
    messages, ledger,
    publish: (operations: CloudSelfAgentSyncOperation[]) => publishCloudSelfAgentOperations({
      accountId: 'account', client, ledger, operations, token: 'test-token',
      saveLedger: () => undefined, mergeMessage: () => undefined,
      shouldPublishProcessing: () => false,
      messageKindForOperation: (operation) => operation.role === 'user' ? 'canonical-history-user' : 'canonical-history-agent',
    }),
  };
}

test('queue admission publishes a request and queued phase before native execution', async () => {
  const queue = publisher();
  const operations = planCloudSelfAgentSync(stateFor('queued'), queue.ledger);
  assert.equal(operations[0]?.queued, true);
  await queue.publish(operations);
  assert.equal(queue.messages.size, 2);
  const response = parseCloudAgentResponse([...queue.messages.values()][1].body);
  assert.equal(response?.execution?.phase, 'queued');
  assert.equal(response?.requestId, 'cloud-1');
  assert.deepEqual(planCloudSelfAgentSync(stateFor('queued'), queue.ledger), []);
});

test('dispatch reuses the queued request identity and preserves its timestamp', async () => {
  const queue = publisher();
  await queue.publish(planCloudSelfAgentSync(stateFor('queued'), queue.ledger));
  const sent = stateFor('sent');
  assert.equal(sent.messages[0].id, queued.id);
  assert.equal(sent.messages[0].createdAtMs, queued.createdAtMs);
  assert.deepEqual(planCloudSelfAgentSync(sent, queue.ledger), []);
  await queue.publish([{
    localMessageId: 'reply-b', sessionId: 'session', role: 'agent', text: 'QUEUE-B complete',
    parentLocalMessageId: queued.id, createdAtMs: 2000, deliveryState: 'complete',
  }]);
  assert.equal(queue.messages.size, 3);
  assert.equal(parseCloudAgentResponse([...queue.messages.values()][2].body)?.requestId, 'cloud-1');
});

test('queued cancellation synchronizes once even after the request was acknowledged', async () => {
  const queue = publisher();
  await queue.publish(planCloudSelfAgentSync(stateFor('queued'), queue.ledger));
  await queue.publish(planCloudSelfAgentSync(stateFor('cancelled'), queue.ledger));
  assert.equal(queue.messages.size, 3);
  assert.equal(parseCloudAgentResponse([...queue.messages.values()][2].body)?.deliveryState, 'cancelled');
  assert.deepEqual(planCloudSelfAgentSync(stateFor('cancelled'), queue.ledger), []);
});

test('read receipts cannot attach an active reply to the next queued request', () => {
  const pending = { ...stateFor('queued').messages[0], status: 'read' };
  assert.equal(localSelfAgentRequestCanPublishExecution(pending), false);
  assert.equal(localSelfAgentRequestCanPublishExecution(stateFor('sent').messages[0]), true);
});

test('hosted queued drafts stay local until dispatch, then publish one executable request', () => {
  const hosted = {
    ...queued,
    runtimeRoute: { model: 'openai/gpt', authProvider: 'openai', authChoice: 'cloud-login:synthetic' },
  };
  const state = (status: 'queued' | 'sent') => {
    const prepared = prepareCanonicalQueuedMessage(hosted, 'human', status)!;
    return {
      ...stateFor(status),
      messages: [{ ...prepared.request, sequenceNum: 1, updatedAtMs: 1000 } as CanonicalSessionMessage],
    };
  };
  const pending = state('queued');
  assert.equal(mapCanonicalMessage(pending.messages[0], new Map())?.statusChips?.[0], 'queued');
  const ledger: CloudSelfAgentSyncLedger = { unrelated: { cloudMessageId: 'other-wire', syncedAtMs: 1 } };
  assert.deepEqual(planCloudSelfAgentSync(pending, ledger), []);
  assert.equal(ledger[hosted.id], undefined, 'a local queue cannot consume the request wire identity');

  const dispatched = planCloudSelfAgentSync(state('sent'), ledger);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].localMessageId, hosted.id);
  assert.equal(dispatched[0].queued, undefined);
  assert.deepEqual(dispatched[0].agentRuntimeRoute, { ...hosted.runtimeRoute, thinking: null });
  assert.equal(cloudSelfAgentForwardMessageKind(dispatched[0], new Set([hosted.sessionId])), null);
});
